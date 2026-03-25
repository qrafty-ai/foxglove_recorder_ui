#include <chrono>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include <rclcpp/rclcpp.hpp>

#include "recorder_companion/recorder_engine.hpp"
#include "recorder_interfaces/msg/recorder_status.hpp"
#include "recorder_interfaces/srv/get_recorder_status.hpp"
#include "recorder_interfaces/srv/pause_recording.hpp"
#include "recorder_interfaces/srv/resume_recording.hpp"
#include "recorder_interfaces/srv/start_recording.hpp"
#include "recorder_interfaces/srv/stop_recording.hpp"

namespace recorder_companion
{

class RecorderCompanionNode : public rclcpp::Node
{
public:
  RecorderCompanionNode()
  : rclcpp::Node("recorder_companion_node")
  {
    status_publisher_ = create_publisher<recorder_interfaces::msg::RecorderStatus>("/recorder_status", 10);

    start_service_ = create_service<recorder_interfaces::srv::StartRecording>(
      "/start_recording",
      std::bind(&RecorderCompanionNode::handleStartRecording, this, std::placeholders::_1, std::placeholders::_2));
    pause_service_ = create_service<recorder_interfaces::srv::PauseRecording>(
      "/pause_recording",
      std::bind(&RecorderCompanionNode::handlePauseRecording, this, std::placeholders::_1, std::placeholders::_2));
    resume_service_ = create_service<recorder_interfaces::srv::ResumeRecording>(
      "/resume_recording",
      std::bind(&RecorderCompanionNode::handleResumeRecording, this, std::placeholders::_1, std::placeholders::_2));
    stop_service_ = create_service<recorder_interfaces::srv::StopRecording>(
      "/stop_recording",
      std::bind(&RecorderCompanionNode::handleStopRecording, this, std::placeholders::_1, std::placeholders::_2));
    status_service_ = create_service<recorder_interfaces::srv::GetRecorderStatus>(
      "/get_recorder_status",
      std::bind(&RecorderCompanionNode::handleGetRecorderStatus, this, std::placeholders::_1, std::placeholders::_2));

    status_timer_ = create_wall_timer(
      std::chrono::milliseconds(500),
      std::bind(&RecorderCompanionNode::publishStatus, this));

    RCLCPP_INFO(get_logger(), "recorder_companion_node ready");
  }

private:
  using StartRequestSharedPtr = recorder_interfaces::srv::StartRecording::Request::SharedPtr;
  using StartResponseSharedPtr = recorder_interfaces::srv::StartRecording::Response::SharedPtr;
  using PauseRequestSharedPtr = recorder_interfaces::srv::PauseRecording::Request::SharedPtr;
  using PauseResponseSharedPtr = recorder_interfaces::srv::PauseRecording::Response::SharedPtr;
  using ResumeRequestSharedPtr = recorder_interfaces::srv::ResumeRecording::Request::SharedPtr;
  using ResumeResponseSharedPtr = recorder_interfaces::srv::ResumeRecording::Response::SharedPtr;
  using StopRequestSharedPtr = recorder_interfaces::srv::StopRecording::Request::SharedPtr;
  using StopResponseSharedPtr = recorder_interfaces::srv::StopRecording::Response::SharedPtr;
  using StatusRequestSharedPtr = recorder_interfaces::srv::GetRecorderStatus::Request::SharedPtr;
  using StatusResponseSharedPtr = recorder_interfaces::srv::GetRecorderStatus::Response::SharedPtr;

  recorder_interfaces::msg::RecorderStatus buildStatusMessage() const
  {
    recorder_interfaces::msg::RecorderStatus message;
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
    std::shared_ptr<RecorderEngine> engine;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      engine = engine_;
    }

    if (engine == nullptr || !engine->pause()) {
      response->success = false;
      response->message = "no active recording to pause";
      RCLCPP_INFO(get_logger(), "pause_recording failed");
      return;
    }

    response->success = true;
    response->message = "recording paused";
    RCLCPP_INFO(get_logger(), "recording paused");
  }

  void handleResumeRecording(const ResumeRequestSharedPtr request, ResumeResponseSharedPtr response)
  {
    (void)request;
    std::shared_ptr<RecorderEngine> engine;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      engine = engine_;
    }

    if (engine == nullptr || !engine->resume()) {
      response->success = false;
      response->message = "no paused recording to resume";
      RCLCPP_INFO(get_logger(), "resume_recording failed");
      return;
    }

    response->success = true;
    response->message = "recording resumed";
    RCLCPP_INFO(get_logger(), "recording resumed");
  }

  void handleStopRecording(const StopRequestSharedPtr request, StopResponseSharedPtr response)
  {
    (void)request;
    std::shared_ptr<RecorderEngine> engine;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      engine = engine_;
    }

    if (engine == nullptr || !engine->stop()) {
      response->success = false;
      response->message = "no active recording to stop";
      response->bag_path = "";
      RCLCPP_INFO(get_logger(), "stop_recording failed");
      return;
    }

    const RecorderStatusSnapshot status = engine->getStatus();
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
  rclcpp::Publisher<recorder_interfaces::msg::RecorderStatus>::SharedPtr status_publisher_;
  rclcpp::Service<recorder_interfaces::srv::StartRecording>::SharedPtr start_service_;
  rclcpp::Service<recorder_interfaces::srv::PauseRecording>::SharedPtr pause_service_;
  rclcpp::Service<recorder_interfaces::srv::ResumeRecording>::SharedPtr resume_service_;
  rclcpp::Service<recorder_interfaces::srv::StopRecording>::SharedPtr stop_service_;
  rclcpp::Service<recorder_interfaces::srv::GetRecorderStatus>::SharedPtr status_service_;
  rclcpp::TimerBase::SharedPtr status_timer_;
};

}

int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);
  auto node = std::make_shared<recorder_companion::RecorderCompanionNode>();
  rclcpp::spin(node);
  rclcpp::shutdown();
  return 0;
}
