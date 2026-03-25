# MCAP Recorder

A Foxglove extension panel for controlling MCAP recording sessions with a ROS2 companion node.

## Features

- **Topic Tree Selection**: Browse available ROS topics in a collapsible namespace tree
- **Subtree Selection**: Select entire topic namespaces with cascade support
- **Recorder Controls**: Start, pause, resume, and stop recording
- **Status Monitoring**: Real-time recorder status from companion node
- **State Persistence**: Selected topics and output directory persist across sessions

## Installation

```bash
npm install
npm run build
npm run local-install
```

## Usage

1. Build and install the extension
2. Open Foxglove Studio
3. Add the "MCAP Recorder" panel to your layout
4. Connect to a ROS2 system with the companion node running
5. Select topics and control recording

## Development

```bash
npm run build        # Build extension
npm run local-install # Install for local testing
npm test             # Run tests
```

## License

MIT
