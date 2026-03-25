import { PanelExtensionContext, Topic } from "@foxglove/extension";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";

import "./globals.css";

const STATUS_TOPIC = "/recorder_status";
const STATUS_PERIOD_MS = 500;
const STALE_AFTER_MS = 2000;

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

type ConnectionStatus = "connected" | "disconnected" | "checking";

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

  const handleCheckboxChange = (checked: boolean) => {
    onToggleSelect(node.fullPath, checked);
  };

  const handleExpandToggle = () => {
    onToggleExpand(node.fullPath);
  };

  if (node.isLeaf) {
    return (
      <div className="flex items-center gap-2 py-1 pl-5" data-testid={`topic-leaf-${node.fullPath}`}>
        <Checkbox
          checked={selectedTopics.has(node.fullPath)}
          onCheckedChange={handleCheckboxChange}
        />
        <span className="text-sm text-muted-foreground" data-testid={`topic-name-${node.fullPath}`}>
          {node.name}
        </span>
      </div>
    );
  }

  const isExpanded = expandedNamespaces.has(node.fullPath);

  return (
    <div className="select-none">
      <div className="flex items-center gap-1 py-1">
        <button
          onClick={handleExpandToggle}
          className="flex h-4 w-4 items-center justify-center rounded-sm hover:bg-accent"
          data-testid={`topic-expand-${node.fullPath}`}
          type="button"
        >
          {isExpanded ? (
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          ) : (
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          )}
        </button>
        <Checkbox
          checked={isFullySelected}
          indeterminate={isPartiallySelected}
          onCheckedChange={handleCheckboxChange}
        />
        <span className="text-sm font-medium" data-testid={`topic-name-${node.fullPath}`}>
          {node.name}
        </span>
      </div>
      {isExpanded && (
        <div className="pl-4" data-testid={`topic-children-${node.fullPath}`}>
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
  const [companionStatus, setCompanionStatus] = useState<ConnectionStatus>("checking");
  const [isLoading, setIsLoading] = useState<"start" | "pause" | "resume" | "stop" | null>(null);
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>(undefined);
  const lastStatusTime = useRef<number | null>(null);

  useLayoutEffect(() => {
    context.watch("topics");
    context.watch("currentFrame");
    context.subscribe([{ topic: STATUS_TOPIC }]);

    context.onRender = (renderState, done) => {
      setTopics(renderState.topics ?? []);

      const statusMessages = renderState.currentFrame?.filter(
        (msg) => msg.topic === STATUS_TOPIC
      );
      if (statusMessages && statusMessages.length > 0) {
        const latestMessage = statusMessages[statusMessages.length - 1]?.message;
        if (latestMessage) {
          setRecorderStatus(latestMessage as RecorderStatus);
          lastStatusTime.current = Date.now();
          setCompanionStatus("connected");
          setConnectionError(null);
        }
      }

      setRenderDone(() => done);
    };

    return () => {
      context.subscribe([]);
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

  useEffect(() => {
    const interval = setInterval(() => {
      const last = lastStatusTime.current;
      const hasStatusTopic = topics.some((t) => t.name === STATUS_TOPIC);

      if (last == null) {
        setCompanionStatus(hasStatusTopic ? "checking" : "disconnected");
        return;
      }

      setCompanionStatus(
        Date.now() - last < STALE_AFTER_MS ? "connected" : "disconnected"
      );
    }, STATUS_PERIOD_MS);

    return () => clearInterval(interval);
  }, [topics]);

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
        if (
          serviceName === "/start_recording" &&
          errorMsg.includes("no serialization format specified")
        ) {
          setConnectionError(null);
          return { success: true, message: "recording start pending status confirmation" };
        }
        setConnectionError(`Service call failed: ${errorMsg}`);
        return null;
      }
    },
    [context]
  );

  const handleStart = useCallback(async () => {
    if (selectedTopics.size === 0) return;
    setIsLoading("start");
    setConnectionError(null);
    const response = await callService("/start_recording", {
      output_directory: outputDirectory,
      topics: Array.from(selectedTopics),
    });
    if (response?.success) {
      // Successfully started - status updates will come via topic subscription
    }
    setIsLoading(null);
  }, [callService, outputDirectory, selectedTopics, context]);

  const handlePause = useCallback(async () => {
    setIsLoading("pause");
    await callService("/pause_recording", {});
    setIsLoading(null);
  }, [callService]);

  const handleResume = useCallback(async () => {
    setIsLoading("resume");
    await callService("/resume_recording", {});
    setIsLoading(null);
  }, [callService]);

  const handleStop = useCallback(async () => {
    setIsLoading("stop");
    await callService("/stop_recording", {});
    // Note: We keep the status subscription active for connection monitoring
    setIsLoading(null);
  }, [callService, context]);

  const isStartDisabled =
    selectedTopics.size === 0 ||
    recorderStatus.state === "recording" ||
    recorderStatus.state === "paused" ||
    companionStatus !== "connected";
  const isPauseDisabled = recorderStatus.state !== "recording" || isLoading !== null;
  const isResumeDisabled = recorderStatus.state !== "paused" || isLoading !== null;
  const isStopDisabled =
    (recorderStatus.state !== "recording" && recorderStatus.state !== "paused") ||
    isLoading !== null;

  const getStatusBadgeVariant = () => {
    switch (companionStatus) {
      case "connected":
        return "default";
      case "disconnected":
        return "destructive";
      case "checking":
        return "secondary";
    }
  };

  return (
    <div className="h-full overflow-auto p-4" data-testid="recorder-root">
      <Card className="mb-4">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">MCAP Recorder</CardTitle>
            <Badge variant={getStatusBadgeVariant()}>
              {companionStatus === "checking" && (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              )}
              {companionStatus === "connected"
                ? "Connected"
                : companionStatus === "disconnected"
                  ? "Disconnected"
                  : "Checking..."}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {(connectionError || recorderStatus.last_error) && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              <strong>Error:</strong> {connectionError || recorderStatus.last_error}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="output-directory">Output Directory</Label>
            <Input
              id="output-directory"
              type="text"
              value={outputDirectory}
              onChange={(e) => setOutputDirectory(e.target.value)}
              data-testid="output-directory-input"
            />
          </div>

          <div className="flex items-center justify-between rounded-md border bg-muted/50 p-3">
            <div>
              <div className="text-sm font-medium">Status</div>
              <div className="text-sm capitalize text-muted-foreground" data-testid="recorder-status">
                {recorderStatus.state}
              </div>
            </div>
            {recorderStatus.recorded_messages > 0 && (
              <div className="text-right">
                <div className="text-sm font-medium">Messages</div>
                <div className="text-sm text-muted-foreground">
                  {recorderStatus.recorded_messages.toLocaleString()}
                </div>
              </div>
            )}
          </div>

          {recorderStatus.current_bag_path && (
            <div className="text-sm text-muted-foreground">
              Bag: {recorderStatus.current_bag_path}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={handleStart}
              disabled={isStartDisabled}
              data-testid="start-recording-button"
            >
              {isLoading === "start" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Start
            </Button>
            <Button
              onClick={handlePause}
              disabled={isPauseDisabled}
              variant="secondary"
              data-testid="pause-recording-button"
            >
              {isLoading === "pause" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Pause
            </Button>
            <Button
              onClick={handleResume}
              disabled={isResumeDisabled}
              variant="secondary"
              data-testid="resume-recording-button"
            >
              {isLoading === "resume" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Resume
            </Button>
            <Button
              onClick={handleStop}
              disabled={isStopDisabled}
              variant="destructive"
              data-testid="stop-recording-button"
            >
              {isLoading === "stop" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Stop
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Topics ({topics.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <div
            className="max-h-[400px] overflow-auto rounded-md border p-2"
            data-testid="topic-tree-root"
          >
            {topicTree.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground" data-testid="recorder-empty-state">
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
        </CardContent>
      </Card>
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
