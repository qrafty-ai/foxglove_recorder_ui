// @vitest-environment node

import { describe, expect, it } from "vitest";
import { searchTopics } from "./useTopicSearch";

const topics = [
  { name: "/a/left/b/c/compressed" },
  { name: "/left/camera/compressed" },
  { name: "/right/compressed" },
  { name: "/left/raw" },
  { name: "/camera/image_raw" },
  { name: "/cam/img" },
  { name: "/camera/info" },
  { name: "/lidar/image" },
  { name: "/lidar/scan" },
  { name: "/sensors/lidar/scan_data" },
  { name: "/camera/scan" },
  { name: "/lidar/points" },
  { name: "/compressed/image" },
] as const;

function getNames(query: string): string[] {
  return searchTopics(topics, query).map(({ item }) => item.name);
}

describe("searchTopics", () => {
  it("requires every word in a multi-word query to match", () => {
    const names = getNames("left compressed");

    expect(names).toEqual([
      "/a/left/b/c/compressed",
      "/left/camera/compressed",
    ]);
  });

  it("matches fuzzy terms across different parts of the topic path", () => {
    const names = getNames("cam img");

    expect(names).toEqual(["/cam/img", "/camera/image_raw"]);
    expect(names).not.toContain("/camera/info");
    expect(names).not.toContain("/lidar/image");
  });

  it("matches multi-word searches anywhere in the path", () => {
    const names = getNames("lidar scan");

    expect(names).toEqual(["/lidar/scan", "/sensors/lidar/scan_data"]);
    expect(names).not.toContain("/camera/scan");
    expect(names).not.toContain("/lidar/points");
  });

  it("still supports single-word fuzzy matches", () => {
    const names = getNames("compressed");

    expect(names).toEqual(
      expect.arrayContaining([
        "/a/left/b/c/compressed",
        "/left/camera/compressed",
        "/right/compressed",
        "/compressed/image",
      ])
    );
  });

  it("merges Fuse matches by key so all matched words can be highlighted", () => {
    const topic = searchTopics(topics, "left compressed").find(
      ({ item }) => item.name === "/a/left/b/c/compressed"
    );

    expect(topic?.matches).toEqual([
      expect.objectContaining({
        key: "name",
        indices: [
          [3, 6],
          [12, 21],
        ],
      }),
    ]);
  });
});
