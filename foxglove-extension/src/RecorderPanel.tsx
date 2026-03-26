import { PanelExtensionContext, Topic } from "@foxglove/extension";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

import { TopicSelectorSection } from "@/components/TopicSelectorSection";

import "./globals.css";

const STATUS_TOPIC = "/recorder_status";
const STATUS_PERIOD_MS = 500;
const STALE_AFTER_MS = 2000;

interface RecorderStatus {
  state: "idle" | "recording" | "paused" | "error";
  active_topics: string[];
  current_bag_path: string;
  last_error: string;
  recorded_messages: number;
}

type ConnectionStatus = "connected" | "disconnected" | "checking";

export function RecorderPanel({ context }: { context: PanelExtensionContext }): React.ReactElement {
  const [topics, setTopics] = useState<readonly Topic[]>([]);
  const [selectedTopics, setSelectedTopics] = useState<Set<string>>(() => {
    const saved = (context.initialState as { selectedTopics?: string[] })?.selectedTopics;
    return new Set(saved ?? []);
  });
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

  const availableTopicNames = useMemo(
    () => new Set(topics.map((t) => t.name)),
    [topics]
  );

  const recordableTopics = useMemo(
    () => Array.from(selectedTopics).filter((t) => availableTopicNames.has(t)),
    [selectedTopics, availableTopicNames]
  );

  const handleToggleTopic = useCallback((topic: string) => {
    setSelectedTopics((prev) => {
      const next = new Set(prev);
      if (next.has(topic)) {
        next.delete(topic);
      } else {
        next.add(topic);
      }
      return next;
    });
  }, []);

  const handleClearAll = useCallback(() => {
    setSelectedTopics(new Set());
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
    if (recordableTopics.length === 0) return;
    setIsLoading("start");
    setConnectionError(null);
    const response = await callService("/start_recording", {
      output_directory: outputDirectory,
      topics: recordableTopics,
    });
    if (response?.success) {
      void response;
    }
    setIsLoading(null);
  }, [callService, outputDirectory, recordableTopics]);

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
    setIsLoading(null);
  }, [callService, context]);

  const isStartDisabled =
    recordableTopics.length === 0 ||
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
          <TopicSelectorSection
            topics={topics}
            selectedTopics={selectedTopics}
            onToggleTopic={handleToggleTopic}
            onClearAll={handleClearAll}
          />
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
