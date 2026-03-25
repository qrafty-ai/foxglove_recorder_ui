#include "recorder_companion/recorder_engine.hpp"

#include <utility>

#include <rosbag2_cpp/writer.hpp>
#include <rosbag2_storage/storage_options.hpp>
#include <rosbag2_transport/record_options.hpp>
#include <rosbag2_transport/recorder.hpp>

namespace recorder_companion
{

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
    rosbag2_storage::StorageOptions storage_options;
    storage_options.uri = output_directory_;
    storage_options.storage_id = "mcap";

    rosbag2_transport::RecordOptions record_options;
    record_options.topics = topics_;

    auto writer = std::make_shared<rosbag2_cpp::Writer>();
    auto recorder = std::make_shared<rosbag2_transport::Recorder>(
      writer,
      storage_options,
      record_options);

    {
      std::lock_guard<std::mutex> lock(mutex_);
      writer_ = std::move(writer);
      recorder_ = std::move(recorder);
      recording_ = true;
      paused_ = false;
      owns_session_ = true;
      state_ = "recording";
      last_error_.clear();
      recorded_messages_ = 0;
    }

    recording_thread_ = std::thread(&RecorderEngine::recordLoop, this);
    return true;
  } catch (const std::exception & error) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      recording_ = false;
      paused_ = false;
      owns_session_ = false;
      state_ = "error";
      last_error_ = error.what();
      recorder_.reset();
      writer_.reset();
    }
    releaseSessionGuard();
    return false;
  }
}

bool RecorderEngine::pause()
{
  std::shared_ptr<rosbag2_transport::Recorder> recorder;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!recording_ || paused_ || recorder_ == nullptr) {
      return false;
    }
    recorder = recorder_;
  }

  try {
    recorder->pause();
    std::lock_guard<std::mutex> lock(mutex_);
    paused_ = true;
    state_ = "paused";
    return true;
  } catch (const std::exception & error) {
    std::lock_guard<std::mutex> lock(mutex_);
    last_error_ = error.what();
    state_ = "error";
    return false;
  }
}

bool RecorderEngine::resume()
{
  std::shared_ptr<rosbag2_transport::Recorder> recorder;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!recording_ || !paused_ || recorder_ == nullptr) {
      return false;
    }
    recorder = recorder_;
  }

  try {
    recorder->resume();
    std::lock_guard<std::mutex> lock(mutex_);
    paused_ = false;
    state_ = "recording";
    return true;
  } catch (const std::exception & error) {
    std::lock_guard<std::mutex> lock(mutex_);
    last_error_ = error.what();
    state_ = "error";
    return false;
  }
}

bool RecorderEngine::stop()
{
  std::shared_ptr<rosbag2_transport::Recorder> recorder;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (recorder_ == nullptr && !recording_thread_.joinable()) {
      return false;
    }
    recorder = recorder_;
    recording_ = false;
    paused_ = false;
    state_ = "stopped";
  }

  try {
    if (recorder != nullptr) {
      recorder->stop();
    }
  } catch (const std::exception & error) {
    std::lock_guard<std::mutex> lock(mutex_);
    last_error_ = error.what();
    state_ = "error";
  }

  if (recording_thread_.joinable()) {
    recording_thread_.join();
  }

  {
    std::lock_guard<std::mutex> lock(mutex_);
    recorder_.reset();
    writer_.reset();
    recording_ = false;
    paused_ = false;
    if (state_ != "error") {
      state_ = "stopped";
    }
  }
  releaseSessionGuard();
  return true;
}

bool RecorderEngine::isRecording() const
{
  std::lock_guard<std::mutex> lock(mutex_);
  return recording_;
}

bool RecorderEngine::isPaused() const
{
  std::lock_guard<std::mutex> lock(mutex_);
  return paused_;
}

RecorderStatusSnapshot RecorderEngine::getStatus() const
{
  std::lock_guard<std::mutex> lock(mutex_);
  return RecorderStatusSnapshot{
    state_,
    topics_,
    output_directory_,
    last_error_,
    recorded_messages_};
}

void RecorderEngine::recordLoop()
{
  std::shared_ptr<rosbag2_transport::Recorder> recorder;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    recorder = recorder_;
  }

  try {
    if (recorder != nullptr) {
      recorder->record();
    }
  } catch (const std::exception & error) {
    std::lock_guard<std::mutex> lock(mutex_);
    last_error_ = error.what();
    state_ = "error";
  }

  {
    std::lock_guard<std::mutex> lock(mutex_);
    recording_ = false;
    paused_ = false;
    recorder_.reset();
    writer_.reset();
    if (state_ != "error" && state_ != "stopped") {
      state_ = "stopped";
    }
  }
  releaseSessionGuard();
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

}
