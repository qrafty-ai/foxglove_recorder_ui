#include <chrono>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <rclcpp/rclcpp.hpp>

#include "recorder_companion/recorder_engine.hpp"
#include "recorder_msgs/msg/recorder_status.hpp"
#include "recorder_msgs/srv/get_recorder_status.hpp"
#include "recorder_msgs/srv/pause_recording.hpp"
#include "recorder_msgs/srv/resume_recording.hpp"
#include "recorder_msgs/srv/start_recording.hpp"
#include "recorder_msgs/srv/stop_recording.hpp"
#include "rosbag2_interfaces/srv/is_paused.hpp"
#include "rosbag2_interfaces/srv/pause.hpp"
#include "rosbag2_interfaces/srv/resume.hpp"

namespace recorder_companion
{

class RecorderCompanionNode : public rclcpp::Node
{
public:
  RecorderCompanionNode()
  : rclcpp::Node("recorder_companion_node")
  {
    status_publisher_ = create_publisher<recorder_msgs::msg::RecorderStatus>("/recorder_status", 10);

    start_service_ = create_service<recorder_msgs::srv::StartRecording>(
      "/start_recording",
      std::bind(&RecorderCompanionNode::handleStartRecording, this, std::placeholders::_1, std::placeholders::_2));
    pause_service_ = create_service<recorder_msgs::srv::PauseRecording>(
      "/pause_recording",
      std::bind(&RecorderCompanionNode::handlePauseRecording, this, std::placeholders::_1, std::placeholders::_2));
    resume_service_ = create_service<recorder_msgs::srv::ResumeRecording>(
      "/resume_recording",
      std::bind(&RecorderCompanionNode::handleResumeRecording, this, std::placeholders::_1, std::placeholders::_2));
    stop_service_ = create_service<recorder_msgs::srv::StopRecording>(
      "/stop_recording",
      std::bind(&RecorderCompanionNode::handleStopRecording, this, std::placeholders::_1, std::placeholders::_2));
    status_service_ = create_service<recorder_msgs::srv::GetRecorderStatus>(
      "/get_recorder_status",
      std::bind(&RecorderCompanionNode::handleGetRecorderStatus, this, std::placeholders::_1, std::placeholders::_2));

    rosbag_pause_client_ = create_client<rosbag2_interfaces::srv::Pause>("/rosbag2_recorder/pause");
    rosbag_resume_client_ = create_client<rosbag2_interfaces::srv::Resume>("/rosbag2_recorder/resume");
    rosbag_is_paused_client_ = create_client<rosbag2_interfaces::srv::IsPaused>("/rosbag2_recorder/is_paused");

    status_timer_ = create_wall_timer(
      std::chrono::milliseconds(500),
      std::bind(&RecorderCompanionNode::publishStatus, this));

    RCLCPP_INFO(get_logger(), "recorder_companion_node ready");
  }

private:
  using StartRequestSharedPtr = recorder_msgs::srv::StartRecording::Request::SharedPtr;
  using StartResponseSharedPtr = recorder_msgs::srv::StartRecording::Response::SharedPtr;
  using PauseRequestSharedPtr = recorder_msgs::srv::PauseRecording::Request::SharedPtr;
  using PauseResponseSharedPtr = recorder_msgs::srv::PauseRecording::Response::SharedPtr;
  using ResumeRequestSharedPtr = recorder_msgs::srv::ResumeRecording::Request::SharedPtr;
  using ResumeResponseSharedPtr = recorder_msgs::srv::ResumeRecording::Response::SharedPtr;
  using StopRequestSharedPtr = recorder_msgs::srv::StopRecording::Request::SharedPtr;
  using StopResponseSharedPtr = recorder_msgs::srv::StopRecording::Response::SharedPtr;
  using StatusRequestSharedPtr = recorder_msgs::srv::GetRecorderStatus::Request::SharedPtr;
  using StatusResponseSharedPtr = recorder_msgs::srv::GetRecorderStatus::Response::SharedPtr;

  template<typename ServiceT>
  bool callRosbagEmptyService(
    const typename rclcpp::Client<ServiceT>::SharedPtr & client,
    const char * service_name,
    std::string & error_message)
  {
    if (!client->wait_for_service(std::chrono::seconds(2))) {
      error_message = std::string("rosbag service unavailable: ") + service_name;
      return false;
    }

    auto request = std::make_shared<typename ServiceT::Request>();
    auto future = client->async_send_request(request);
    if (future.wait_for(std::chrono::seconds(2)) != std::future_status::ready) {
      error_message = std::string("rosbag service timed out: ") + service_name;
      return false;
    }
    future.get();
    return true;
  }

  std::optional<bool> queryRosbagPaused()
  {
    if (!rosbag_is_paused_client_->wait_for_service(std::chrono::milliseconds(100))) {
      return std::nullopt;
    }

    auto request = std::make_shared<rosbag2_interfaces::srv::IsPaused::Request>();
    auto future = rosbag_is_paused_client_->async_send_request(request);
    if (future.wait_for(std::chrono::milliseconds(200)) != std::future_status::ready) {
      return std::nullopt;
    }

    return future.get()->paused;
  }

  recorder_msgs::msg::RecorderStatus buildStatusMessage()
  {
    recorder_msgs::msg::RecorderStatus message;
    message.stamp = now();

    std::shared_ptr<RecorderEngine> engine;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      engine = engine_;
    }

    if (engine == nullptr) {
      message.state = "idle";
      message.current_bag_path = "";
      message.last_error = "";
      message.recorded_messages = 0;
      return message;
    }

    if (const auto paused = queryRosbagPaused()) {
      engine->setPaused(*paused);
    }

    const RecorderStatusSnapshot status = engine->getStatus();
    message.state = status.state;
    message.active_topics = status.active_topics;
    message.current_bag_path = status.current_bag_path;
    message.last_error = status.last_error;
    message.recorded_messages = status.recorded_messages;
    return message;
  }

  void handleStartRecording(const StartRequestSharedPtr request, StartResponseSharedPtr response)
  {
    RCLCPP_INFO(
      get_logger(),
      "start_recording request output_directory=%s topic_count=%zu",
      request->output_directory.c_str(),
      request->topics.size());
    auto engine = std::make_shared<RecorderEngine>(request->output_directory, request->topics);
    if (!engine->start()) {
      const RecorderStatusSnapshot status = engine->getStatus();
      response->success = false;
      response->message = status.last_error.empty() ? "failed to start recording" : status.last_error;
      RCLCPP_INFO(get_logger(), "start_recording failed: %s", response->message.c_str());
      return;
    }

    {
      std::lock_guard<std::mutex> lock(mutex_);
      engine_ = std::move(engine);
    }

    response->success = true;
    response->message = "recording started";
    RCLCPP_INFO(get_logger(), "recording started: %s", request->output_directory.c_str());
  }

  void handlePauseRecording(const PauseRequestSharedPtr request, PauseResponseSharedPtr response)
  {
    (void)request;
    RCLCPP_INFO(get_logger(), "pause_recording service invoked");
    std::shared_ptr<RecorderEngine> engine;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      engine = engine_;
    }

    if (engine == nullptr) {
      response->success = false;
      response->message = "no active recording to pause";
      RCLCPP_INFO(get_logger(), "pause_recording failed");
      return;
    }

    std::string error_message;
    if (!callRosbagEmptyService<rosbag2_interfaces::srv::Pause>(
        rosbag_pause_client_, "/rosbag2_recorder/pause", error_message)) {
      response->success = false;
      response->message = error_message;
      RCLCPP_INFO(get_logger(), "pause_recording failed: %s", response->message.c_str());
      return;
    }

    engine->setPaused(true);
    response->success = true;
    response->message = "recording paused";
    RCLCPP_INFO(get_logger(), "recording paused");
  }

  void handleResumeRecording(const ResumeRequestSharedPtr request, ResumeResponseSharedPtr response)
  {
    (void)request;
    RCLCPP_INFO(get_logger(), "resume_recording service invoked");
    std::shared_ptr<RecorderEngine> engine;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      engine = engine_;
    }

    if (engine == nullptr) {
      response->success = false;
      response->message = "no paused recording to resume";
      RCLCPP_INFO(get_logger(), "resume_recording failed");
      return;
    }

    std::string error_message;
    if (!callRosbagEmptyService<rosbag2_interfaces::srv::Resume>(
        rosbag_resume_client_, "/rosbag2_recorder/resume", error_message)) {
      response->success = false;
      response->message = error_message;
      RCLCPP_INFO(get_logger(), "resume_recording failed: %s", response->message.c_str());
      return;
    }

    engine->setPaused(false);
    response->success = true;
    response->message = "recording resumed";
    RCLCPP_INFO(get_logger(), "recording resumed");
  }

  void handleStopRecording(const StopRequestSharedPtr request, StopResponseSharedPtr response)
  {
    (void)request;
    RCLCPP_INFO(get_logger(), "stop_recording service invoked");
    std::shared_ptr<RecorderEngine> engine;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      engine = engine_;
    }

    if (engine == nullptr || !engine->stop()) {
      const RecorderStatusSnapshot status = engine == nullptr ? RecorderStatusSnapshot{} : engine->getStatus();
      response->success = false;
      response->message = status.last_error.empty() ? "no active recording to stop" : status.last_error;
      response->bag_path = "";
      RCLCPP_INFO(get_logger(), "stop_recording failed: %s", response->message.c_str());
      return;
    }

    const RecorderStatusSnapshot status = engine->getStatus();
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (engine_ == engine) {
        engine_.reset();
      }
    }
    response->success = true;
    response->message = "recording stopped";
    response->bag_path = status.current_bag_path;
    RCLCPP_INFO(get_logger(), "recording stopped: %s", response->bag_path.c_str());
  }

  void handleGetRecorderStatus(const StatusRequestSharedPtr request, StatusResponseSharedPtr response)
  {
    (void)request;
    const auto status_message = buildStatusMessage();
    response->state = status_message.state;
    response->active_topics = status_message.active_topics;
    response->current_bag_path = status_message.current_bag_path;
    response->last_error = status_message.last_error;
  }

  void publishStatus()
  {
    status_publisher_->publish(buildStatusMessage());
  }

  mutable std::mutex mutex_;
  std::shared_ptr<RecorderEngine> engine_;
  rclcpp::Publisher<recorder_msgs::msg::RecorderStatus>::SharedPtr status_publisher_;
  rclcpp::Service<recorder_msgs::srv::StartRecording>::SharedPtr start_service_;
  rclcpp::Service<recorder_msgs::srv::PauseRecording>::SharedPtr pause_service_;
  rclcpp::Service<recorder_msgs::srv::ResumeRecording>::SharedPtr resume_service_;
  rclcpp::Service<recorder_msgs::srv::StopRecording>::SharedPtr stop_service_;
  rclcpp::Service<recorder_msgs::srv::GetRecorderStatus>::SharedPtr status_service_;
  rclcpp::Client<rosbag2_interfaces::srv::Pause>::SharedPtr rosbag_pause_client_;
  rclcpp::Client<rosbag2_interfaces::srv::Resume>::SharedPtr rosbag_resume_client_;
  rclcpp::Client<rosbag2_interfaces::srv::IsPaused>::SharedPtr rosbag_is_paused_client_;
  rclcpp::TimerBase::SharedPtr status_timer_;
};

}

int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);
  auto node = std::make_shared<recorder_companion::RecorderCompanionNode>();
  rclcpp::executors::MultiThreadedExecutor executor(rclcpp::ExecutorOptions(), 2);
  executor.add_node(node);
  executor.spin();
  rclcpp::shutdown();
  return 0;
}
