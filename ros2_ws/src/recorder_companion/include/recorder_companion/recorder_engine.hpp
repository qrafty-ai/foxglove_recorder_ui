#ifndef RECORDER_COMPANION__RECORDER_ENGINE_HPP_
#define RECORDER_COMPANION__RECORDER_ENGINE_HPP_

#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace rosbag2_cpp
{
class Writer;
}

namespace rosbag2_transport
{
class Recorder;
}

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
  bool pause();
  bool resume();
  bool stop();

  bool isRecording() const;
  bool isPaused() const;
  RecorderStatusSnapshot getStatus() const;

private:
  void recordLoop();
  void releaseSessionGuard();

  mutable std::mutex mutex_;
  std::string output_directory_;
  std::vector<std::string> topics_;
  std::string state_{"idle"};
  std::string last_error_;
  std::uint64_t recorded_messages_{0};
  bool recording_{false};
  bool paused_{false};
  bool owns_session_{false};
  std::shared_ptr<rosbag2_cpp::Writer> writer_;
  std::shared_ptr<rosbag2_transport::Recorder> recorder_;
  std::thread recording_thread_;

  static std::mutex session_mutex_;
  static bool session_active_;
};

}

#endif
