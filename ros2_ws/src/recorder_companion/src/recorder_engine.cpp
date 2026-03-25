#include "recorder_companion/recorder_engine.hpp"

#include <boost/process/v2.hpp>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <iomanip>
#include <rclcpp/rclcpp.hpp>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unistd.h>
#include <utility>
#include <vector>

namespace recorder_companion
{

namespace bp = boost::process::v2;

namespace
{

constexpr std::chrono::milliseconds kStartupProbeDelay(300);
constexpr std::chrono::milliseconds kStopPollInterval(100);
constexpr std::chrono::seconds kStopTimeout(5);
constexpr std::chrono::seconds kKillTimeout(2);

bool hasBagArtifacts(const std::string & path)
{
  const std::filesystem::path bag_path(path);
  if (bag_path.empty()) {
    return false;
  }
  if (std::filesystem::is_regular_file(bag_path)) {
    return true;
  }
  if (!std::filesystem::is_directory(bag_path)) {
    return false;
  }
  if (std::filesystem::exists(bag_path / "metadata.yaml")) {
    return true;
  }
  for (const auto & entry : std::filesystem::directory_iterator(bag_path)) {
    if (!entry.is_regular_file()) {
      continue;
    }
    const auto extension = entry.path().extension().string();
    if (extension == ".db3" || extension == ".mcap") {
      return true;
    }
  }
  return false;
}

}

std::mutex RecorderEngine::session_mutex_;
bool RecorderEngine::session_active_ = false;

RecorderEngine::RecorderEngine(std::string output_directory, std::vector<std::string> topics)
: output_directory_(std::move(output_directory)),
  topics_(std::move(topics))
{
}

RecorderEngine::~RecorderEngine()
{
  stop();
}

bool RecorderEngine::start()
{
  {
    std::lock_guard<std::mutex> session_lock(session_mutex_);
    if (session_active_) {
      std::lock_guard<std::mutex> lock(mutex_);
      last_error_ = "another recording session is already active";
      state_ = "error";
      return false;
    }
    session_active_ = true;
  }

  try {
    if (topics_.empty()) {
      throw std::runtime_error("no topics selected for recording");
    }

    const std::string executable = resolveExecutable("ros2");
    const std::string expanded_directory = expandUserPath(output_directory_);
    std::filesystem::create_directories(expanded_directory);
    const std::string session_path = createSessionPath(expanded_directory);
    const std::string log_path = session_path + ".log";

    std::vector<std::string> arguments = {
      "bag",
      "record",
      "-o",
      session_path,
    };
    arguments.insert(arguments.end(), topics_.begin(), topics_.end());

    std::ostringstream command;
    command << executable;
    for (const std::string & argument : arguments) {
      command << ' ';
      if (argument.find_first_of(" \t\n\"'\\$`") != std::string::npos) {
        command << std::quoted(argument);
      } else {
        command << argument;
      }
    }

    std::FILE * log_file = std::fopen(log_path.c_str(), "w");
    if (log_file == nullptr) {
      throw std::runtime_error("failed to open cli recorder log file: " + log_path);
    }

    RCLCPP_INFO(
      rclcpp::get_logger("recorder_engine"),
      "launching cli recorder command=%s log_path=%s",
      command.str().c_str(),
      log_path.c_str());

    auto child = std::make_unique<bp::process>(
      io_context_,
      executable,
      arguments,
      bp::process_stdio{nullptr, log_file, log_file});

    std::fclose(log_file);

    std::this_thread::sleep_for(kStartupProbeDelay);
    if (!child->running()) {
      child->wait();
      throw std::runtime_error(
        "ros2 bag record exited during startup: " + formatExitStatus(child->exit_code()));
    }

    {
      std::lock_guard<std::mutex> lock(mutex_);
      child_ = std::move(child);
      current_bag_path_ = session_path;
      log_path_ = log_path;
      recording_ = true;
      paused_ = false;
      stop_requested_ = false;
      owns_session_ = true;
      state_ = "recording";
      last_error_.clear();
      recorded_messages_ = 0;
    }

    RCLCPP_INFO(
      rclcpp::get_logger("recorder_engine"),
      "started cli recorder pid=%d bag_path=%s topic_count=%zu",
      static_cast<int>(child_->id()),
      session_path.c_str(),
      topics_.size());
    return true;
  } catch (const std::exception & error) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      child_.reset();
      recording_ = false;
      paused_ = false;
      stop_requested_ = false;
      owns_session_ = false;
      state_ = "error";
      last_error_ = error.what();
      current_bag_path_.clear();
      log_path_.clear();
    }
    releaseSessionGuard();
    return false;
  }
}

bool RecorderEngine::stop()
{
  pollChildProcess();

  bool was_running = false;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!child_ || !recording_) {
      return false;
    }
    stop_requested_ = true;
    was_running = true;
  }

  if (!was_running) {
    return false;
  }

  auto wait_for_exit = [this](std::chrono::steady_clock::duration timeout) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < deadline) {
      if (pollChildProcess()) {
        return true;
      }
      std::this_thread::sleep_for(kStopPollInterval);
    }
    return pollChildProcess();
  };

  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (child_) {
      child_->interrupt();
    }
  }
  if (!wait_for_exit(kStopTimeout)) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (child_) {
      child_->request_exit();
    }
  }
  if (!wait_for_exit(kKillTimeout)) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (child_) {
      child_->terminate();
    }
  }
  wait_for_exit(kKillTimeout);

  {
    std::lock_guard<std::mutex> lock(mutex_);
    const bool stopped_cleanly = !child_ && state_ != "error";
    recording_ = false;
    paused_ = false;
    stop_requested_ = false;
    if (!stopped_cleanly) {
      return false;
    }
  }

  if (!hasBagArtifacts(current_bag_path_)) {
    std::lock_guard<std::mutex> lock(mutex_);
    state_ = "error";
    last_error_ = "recorder exited but no bag artifacts were found at " + current_bag_path_;
    return false;
  }

  std::lock_guard<std::mutex> lock(mutex_);
  state_ = "stopped";
  return true;
}

bool RecorderEngine::isRecording()
{
  pollChildProcess();
  std::lock_guard<std::mutex> lock(mutex_);
  return recording_;
}

bool RecorderEngine::isPaused()
{
  pollChildProcess();
  std::lock_guard<std::mutex> lock(mutex_);
  return paused_;
}

RecorderStatusSnapshot RecorderEngine::getStatus()
{
  pollChildProcess();
  std::lock_guard<std::mutex> lock(mutex_);
  return RecorderStatusSnapshot{
    state_,
    topics_,
    current_bag_path_,
    last_error_,
    recorded_messages_};
}

void RecorderEngine::setPaused(bool paused)
{
  std::lock_guard<std::mutex> lock(mutex_);
  paused_ = paused;
  if (recording_) {
    state_ = paused ? "paused" : "recording";
  }
}

bool RecorderEngine::pollChildProcess()
{
  std::unique_ptr<bp::process> * child = nullptr;
  bool stop_requested = false;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!child_) {
      return true;
    }
    child = &child_;
    stop_requested = stop_requested_;
  }

  boost::system::error_code ec;
  if ((*child)->running(ec)) {
    return false;
  }
  if (ec) {
    std::lock_guard<std::mutex> lock(mutex_);
    state_ = "error";
    last_error_ = "failed to query cli recorder state: " + ec.message();
    child_.reset();
    recording_ = false;
    paused_ = false;
    stop_requested_ = false;
    releaseSessionGuard();
    return true;
  }

  const int exit_code = (*child)->exit_code();
  {
    std::lock_guard<std::mutex> lock(mutex_);
    child_.reset();
    recording_ = false;
    paused_ = false;
    stop_requested_ = false;
    if (stop_requested) {
      if (state_ != "error") {
        state_ = "stopped";
      }
    } else if (exit_code == 0) {
      state_ = "stopped";
    } else {
      state_ = "error";
      last_error_ = "cli recorder exited unexpectedly: " + formatExitStatus(exit_code);
    }
  }

  releaseSessionGuard();
  return true;
}

void RecorderEngine::releaseSessionGuard()
{
  bool should_release = false;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    should_release = owns_session_;
    owns_session_ = false;
  }

  if (!should_release) {
    return;
  }

  std::lock_guard<std::mutex> session_lock(session_mutex_);
  session_active_ = false;
}

std::string RecorderEngine::expandUserPath(const std::string & path)
{
  if (path.empty()) {
    throw std::runtime_error("output directory is required");
  }

  std::string expanded = path;
  if (path == "~" || (path.size() >= 2 && path[0] == '~' && path[1] == '/')) {
    const char * home = std::getenv("HOME");
    if (home == nullptr || std::string(home).empty()) {
      throw std::runtime_error("HOME is not set; cannot expand output directory");
    }
    expanded = path == "~" ? std::string(home) : std::string(home) + path.substr(1);
  }

  return std::filesystem::absolute(expanded).string();
}

std::string RecorderEngine::createSessionPath(const std::string & directory)
{
  const std::time_t now = std::time(nullptr);
  const std::tm local_time = *std::localtime(&now);

  std::ostringstream session_name;
  session_name << "recording_" << std::put_time(&local_time, "%Y%m%d_%H%M%S");
  return (std::filesystem::path(directory) / session_name.str()).string();
}

std::string RecorderEngine::resolveExecutable(const std::string & executable_name)
{
  const char * path_env = std::getenv("PATH");
  if (path_env == nullptr) {
    throw std::runtime_error("PATH is not set; cannot resolve executable " + executable_name);
  }

  std::stringstream path_stream(path_env);
  std::string entry;
  while (std::getline(path_stream, entry, ':')) {
    const auto candidate = std::filesystem::path(entry) / executable_name;
    if (std::filesystem::exists(candidate) && ::access(candidate.c_str(), X_OK) == 0) {
      return candidate.string();
    }
  }

  throw std::runtime_error("failed to locate executable in PATH: " + executable_name);
}

std::string RecorderEngine::formatExitStatus(int exit_code)
{
  return "exit code " + std::to_string(exit_code);
}

}
