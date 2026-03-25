cmake_minimum_required(VERSION 3.8)
project(recorder_companion)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)
find_package(rosbag2_cpp REQUIRED)
find_package(rosbag2_transport REQUIRED)
find_package(rosbag2_storage REQUIRED)
find_package(recorder_interfaces REQUIRED)

add_executable(recorder_companion_node
  src/recorder_companion_node.cpp
  src/recorder_engine.cpp
)

target_compile_features(recorder_companion_node PUBLIC cxx_std_17)
target_include_directories(recorder_companion_node PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include>
)

ament_target_dependencies(recorder_companion_node
  rclcpp
  rosbag2_cpp
  rosbag2_transport
  rosbag2_storage
  recorder_interfaces
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
