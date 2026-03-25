import { PanelExtensionContext, Topic } from "@foxglove/extension";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

interface TreeNode {
  name: string;
  fullPath: string;
  isLeaf: boolean;
  children: TreeNode[];
}

interface RecorderStatus {
  state: "idle" | "recording" | "paused" | "error";
  active_topics: string[];
  current_bag_path: string;
  last_error: string;
  recorded_messages: number;
}

function buildTopicTree(topics: readonly Topic[]): TreeNode[] {
  const root: TreeNode[] = [];
  const nodeMap = new Map<string, TreeNode>();

  topics.forEach((topic) => {
    const parts = topic.name.split("/").filter(Boolean);
    let currentPath = "";

    parts.forEach((part, index) => {
      const parentPath = currentPath;
      currentPath = currentPath ? `${currentPath}/${part}` : `/${part}`;

      if (!nodeMap.has(currentPath)) {
        const node: TreeNode = {
          name: part,
          fullPath: currentPath,
          isLeaf: index === parts.length - 1,
          children: [],
        };
        nodeMap.set(currentPath, node);

        if (parentPath === "") {
          root.push(node);
        } else {
          const parent = nodeMap.get(parentPath);
          if (parent) {
            parent.children.push(node);
          }
        }
      }
    });
  });

  root.sort((a, b) => a.name.localeCompare(b.name));
  nodeMap.forEach((node) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
  });

  return root;
}

function getAllDescendantPaths(node: TreeNode): string[] {
  const paths: string[] = [];
  if (node.isLeaf) {
    paths.push(node.fullPath);
  }
  node.children.forEach((child) => {
    paths.push(...getAllDescendantPaths(child));
  });
  return paths;
}

interface TreeNodeProps {
  node: TreeNode;
  selectedTopics: Set<string>;
  expandedNamespaces: Set<string>;
  onToggleSelect: (path: string, selected: boolean) => void;
  onToggleExpand: (path: string) => void;
}

function TreeNodeComponent({
  node,
  selectedTopics,
  expandedNamespaces,
  onToggleSelect,
  onToggleExpand,
}: TreeNodeProps): React.ReactElement {
  const descendantPaths = useMemo(() => getAllDescendantPaths(node), [node]);
  const selectedCount = descendantPaths.filter((p) => selectedTopics.has(p)).length;
  const isFullySelected = selectedCount === descendantPaths.length && descendantPaths.length > 0;
  const isPartiallySelected = selectedCount > 0 && selectedCount < descendantPaths.length;

  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onToggleSelect(node.fullPath, e.target.checked);
  };

  const handleExpandToggle = () => {
    onToggleExpand(node.fullPath);
  };

  if (node.isLeaf) {
    return (
      <div style={{ marginLeft: 20, display: "flex", alignItems: "center" }}>
        <input
          type="checkbox"
          checked={selectedTopics.has(node.fullPath)}
          onChange={handleCheckboxChange}
          data-testid={`topic-leaf-${node.fullPath}`}
        />
        <span style={{ marginLeft: 4 }} data-testid={`topic-name-${node.fullPath}`}>
          {node.name}
        </span>
      </div>
    );
  }

  const isExpanded = expandedNamespaces.has(node.fullPath);

  return (
    <div style={{ marginLeft: 20 }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <button
          onClick={handleExpandToggle}
          style={{
            width: 20,
            height: 20,
            border: "none",
            background: "transparent",
            cursor: "pointer",
            fontSize: 12,
          }}
          data-testid={`topic-expand-${node.fullPath}`}
        >
          {isExpanded ? "▼" : "▶"}
        </button>
        <input
          type="checkbox"
          checked={isFullySelected}
          ref={(el) => {
            if (el) {
              el.indeterminate = isPartiallySelected;
            }
          }}
          onChange={handleCheckboxChange}
          data-testid={`topic-node-${node.fullPath}`}
        />
        <span style={{ marginLeft: 4, fontWeight: "bold" }} data-testid={`topic-name-${node.fullPath}`}>
          {node.name}
        </span>
      </div>
      {isExpanded && (
        <div data-testid={`topic-children-${node.fullPath}`}>
          {node.children.map((child) => (
            <TreeNodeComponent
              key={child.fullPath}
              node={child}
              selectedTopics={selectedTopics}
              expandedNamespaces={expandedNamespaces}
              onToggleSelect={onToggleSelect}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function RecorderPanel({ context }: { context: PanelExtensionContext }): React.ReactElement {
  const [topics, setTopics] = useState<readonly Topic[]>([]);
  const [selectedTopics, setSelectedTopics] = useState<Set<string>>(() => {
    const saved = (context.initialState as { selectedTopics?: string[] })?.selectedTopics;
    return new Set(saved ?? []);
  });
  const [expandedNamespaces, setExpandedNamespaces] = useState<Set<string>>(new Set());
  const [outputDirectory, setOutputDirectory] = useState(() => {
    const saved = (context.initialState as { outputDirectory?: string })?.outputDirectory;
    return saved ?? "~/rosbags";
  });
  const [recorderStatus, setRecorderStatus] = useState<RecorderStatus>({
    state: "idle",
    active_topics: [],
    current_bag_path: "",
    last_error: "",
    recorded_messages: 0,
  });
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>(undefined);

  useLayoutEffect(() => {
    context.watch("topics");
    context.watch("currentFrame");

    context.onRender = (renderState, done) => {
      setTopics(renderState.topics ?? []);

      const statusMessages = renderState.currentFrame?.filter(
        (msg) => msg.topic === "/recorder_status"
      );
      if (statusMessages && statusMessages.length > 0) {
        const latestMessage = statusMessages[statusMessages.length - 1]?.message;
        if (latestMessage) {
          setRecorderStatus(latestMessage as RecorderStatus);
        }
      }

      setRenderDone(() => done);
    };
  }, [context]);

  useEffect(() => {
    if (renderDone) {
      renderDone();
    }
  }, [renderDone]);

  useEffect(() => {
    context.saveState({
      selectedTopics: Array.from(selectedTopics),
      outputDirectory,
    });
  }, [context, selectedTopics, outputDirectory]);

  const topicTree = useMemo(() => buildTopicTree(topics), [topics]);

  const handleToggleSelect = useCallback(
    (path: string, selected: boolean) => {
      setSelectedTopics((prev) => {
        const next = new Set(prev);

        const toggleDescendants = (node: TreeNode) => {
          const descendants = getAllDescendantPaths(node);
          descendants.forEach((p) => {
            if (selected) {
              next.add(p);
            } else {
              next.delete(p);
            }
          });
        };

        const findNode = (nodes: TreeNode[], targetPath: string): TreeNode | null => {
          for (const node of nodes) {
            if (node.fullPath === targetPath) {
              return node;
            }
            const found = findNode(node.children, targetPath);
            if (found) return found;
          }
          return null;
        };

        const node = findNode(topicTree, path);
        if (node) {
          toggleDescendants(node);
        } else {
          if (selected) {
            next.add(path);
          } else {
            next.delete(path);
          }
        }

        return next;
      });
    },
    [topicTree]
  );

  const handleToggleExpand = useCallback((path: string) => {
    setExpandedNamespaces((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const callService = useCallback(
    async (serviceName: string, request: unknown) => {
      if (!context.callService) {
        setConnectionError("Service calling not supported");
        return null;
      }
      try {
        const response = await context.callService(serviceName, request);
        setConnectionError(null);
        return response as { success: boolean; message: string };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        setConnectionError(`Service call failed: ${errorMsg}`);
        return null;
      }
    },
    [context]
  );

  const handleStart = useCallback(async () => {
    if (selectedTopics.size === 0) return;
    const response = await callService("/start_recording", {
      output_directory: outputDirectory,
      topics: Array.from(selectedTopics),
    });
    if (response?.success) {
      context.subscribe([{ topic: "/recorder_status" }]);
    }
  }, [callService, outputDirectory, selectedTopics, context]);

  const handlePause = useCallback(async () => {
    await callService("/pause_recording", {});
  }, [callService]);

  const handleResume = useCallback(async () => {
    await callService("/resume_recording", {});
  }, [callService]);

  const handleStop = useCallback(async () => {
    await callService("/stop_recording", {});
    context.unsubscribeAll();
  }, [callService, context]);

  const isStartDisabled =
    selectedTopics.size === 0 ||
    recorderStatus.state === "recording" ||
    recorderStatus.state === "paused";
  const isPauseDisabled = recorderStatus.state !== "recording";
  const isResumeDisabled = recorderStatus.state !== "paused";
  const isStopDisabled = recorderStatus.state !== "recording" && recorderStatus.state !== "paused";

  return (
    <div style={{ padding: "1rem", height: "100%", overflow: "auto" }} data-testid="recorder-root">
      <h2>MCAP Recorder</h2>

      {connectionError && (
        <div
          style={{
            background: "#fee",
            border: "1px solid #fcc",
            padding: "0.5rem",
            marginBottom: "1rem",
            borderRadius: 4,
          }}
          data-testid="recorder-error-banner"
        >
          <strong>Error:</strong> {connectionError}
        </div>
      )}

      <div style={{ marginBottom: "1rem" }}>
        <label style={{ display: "block", marginBottom: "0.25rem", fontWeight: "bold" }}>
          Output Directory
        </label>
        <input
          type="text"
          value={outputDirectory}
          onChange={(e) => setOutputDirectory(e.target.value)}
          style={{ width: "100%", padding: "0.25rem" }}
          data-testid="output-directory-input"
        />
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <div style={{ fontWeight: "bold", marginBottom: "0.5rem" }}>Status:</div>
        <div data-testid="recorder-status" style={{ textTransform: "capitalize" }}>
          {recorderStatus.state}
        </div>
        {recorderStatus.current_bag_path && (
          <div style={{ fontSize: "0.875rem", color: "#666" }}>
            Bag: {recorderStatus.current_bag_path}
          </div>
        )}
        {recorderStatus.recorded_messages > 0 && (
          <div style={{ fontSize: "0.875rem", color: "#666" }}>
            Messages: {recorderStatus.recorded_messages}
          </div>
        )}
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <button
          onClick={handleStart}
          disabled={isStartDisabled}
          style={{ marginRight: "0.5rem" }}
          data-testid="start-recording-button"
        >
          Start
        </button>
        <button
          onClick={handlePause}
          disabled={isPauseDisabled}
          style={{ marginRight: "0.5rem" }}
          data-testid="pause-recording-button"
        >
          Pause
        </button>
        <button
          onClick={handleResume}
          disabled={isResumeDisabled}
          style={{ marginRight: "0.5rem" }}
          data-testid="resume-recording-button"
        >
          Resume
        </button>
        <button onClick={handleStop} disabled={isStopDisabled} data-testid="stop-recording-button">
          Stop
        </button>
      </div>

      <div style={{ fontWeight: "bold", marginBottom: "0.5rem" }}>Topics ({topics.length}):</div>
      <div
        style={{
          border: "1px solid #ccc",
          borderRadius: 4,
          padding: "0.5rem",
          maxHeight: "400px",
          overflow: "auto",
        }}
        data-testid="topic-tree-root"
      >
        {topicTree.length === 0 ? (
          <div style={{ color: "#999" }} data-testid="recorder-empty-state">
            No topics available
          </div>
        ) : (
          topicTree.map((node) => (
            <TreeNodeComponent
              key={node.fullPath}
              node={node}
              selectedTopics={selectedTopics}
              expandedNamespaces={expandedNamespaces}
              onToggleSelect={handleToggleSelect}
              onToggleExpand={handleToggleExpand}
            />
          ))
        )}
      </div>

      {recorderStatus.last_error && (
        <div
          style={{
            background: "#fee",
            border: "1px solid #fcc",
            padding: "0.5rem",
            marginTop: "1rem",
            borderRadius: 4,
          }}
        >
          <strong>Recorder Error:</strong> {recorderStatus.last_error}
        </div>
      )}
    </div>
  );
}

export function initRecorderPanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<RecorderPanel context={context} />);
  return () => {
    root.unmount();
  };
}
