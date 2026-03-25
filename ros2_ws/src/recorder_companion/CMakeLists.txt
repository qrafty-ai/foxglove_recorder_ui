cmake_minimum_required(VERSION 3.8)
project(recorder_companion)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

find_package(ament_cmake REQUIRED)
find_package(boost_process CONFIG REQUIRED)
find_package(rclcpp REQUIRED)
find_package(recorder_msgs REQUIRED)
find_package(rosbag2_interfaces REQUIRED)

add_executable(recorder_companion_node
  src/recorder_companion_node.cpp
  src/recorder_engine.cpp
)

target_compile_features(recorder_companion_node PUBLIC cxx_std_17)
target_include_directories(recorder_companion_node PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include>
)

target_link_libraries(recorder_companion_node PUBLIC
  ${recorder_msgs_TARGETS}
  ${rosbag2_interfaces_TARGETS}
  rclcpp::rclcpp
  Boost::process
)

install(TARGETS recorder_companion_node
  DESTINATION lib/${PROJECT_NAME}
)

install(DIRECTORY include/
  DESTINATION include
)

install(DIRECTORY launch
  DESTINATION share/${PROJECT_NAME}
)

ament_package()
