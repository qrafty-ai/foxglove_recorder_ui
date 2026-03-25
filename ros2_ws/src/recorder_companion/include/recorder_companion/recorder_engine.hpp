#ifndef RECORDER_COMPANION__RECORDER_ENGINE_HPP_
#define RECORDER_COMPANION__RECORDER_ENGINE_HPP_

#include <boost/asio/io_context.hpp>
#include <boost/process/v2/process.hpp>

#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace recorder_companion
{

struct RecorderStatusSnapshot
{
  std::string state{"idle"};
  std::vector<std::string> active_topics;
  std::string current_bag_path;
  std::string last_error;
  std::uint64_t recorded_messages{0};
};

class RecorderEngine
{
public:
  RecorderEngine(std::string output_directory, std::vector<std::string> topics);
  ~RecorderEngine();

  bool start();
  bool stop();

  bool isRecording();
  bool isPaused();
  RecorderStatusSnapshot getStatus();
  void setPaused(bool paused);

private:
  bool pollChildProcess();
  void releaseSessionGuard();
  static std::string expandUserPath(const std::string & path);
  static std::string createSessionPath(const std::string & directory);
  static std::string resolveExecutable(const std::string & executable_name);
  static std::string formatExitStatus(int exit_code);

  mutable std::mutex mutex_;
  boost::asio::io_context io_context_;
  std::string output_directory_;
  std::string current_bag_path_;
  std::string log_path_;
  std::vector<std::string> topics_;
  std::string state_{"idle"};
  std::string last_error_;
  std::uint64_t recorded_messages_{0};
  bool recording_{false};
  bool paused_{false};
  bool stop_requested_{false};
  bool owns_session_{false};
  std::unique_ptr<boost::process::v2::process> child_;

  static std::mutex session_mutex_;
  static bool session_active_;
};

}

#endif
