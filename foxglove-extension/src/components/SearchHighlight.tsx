import React from "react";

type FuseResultMatch = {
  indices: readonly [number, number][];
  key?: string;
};

interface SearchHighlightProps {
  text: string;
  matches?: readonly FuseResultMatch[];
  matchKey: "name" | "schemaName";
  highlightClassName?: string;
}

export function SearchHighlight({
  text,
  matches,
  matchKey,
  highlightClassName = "bg-primary/20 text-primary font-medium rounded px-0.5",
}: SearchHighlightProps): React.ReactElement {
  if (!matches || matches.length === 0) {
    return <>{text}</>;
  }

  const keyMatch = matches.find((m) => m.key === matchKey);
  if (!keyMatch || !keyMatch.indices || keyMatch.indices.length === 0) {
    return <>{text}</>;
  }

  const indices = keyMatch.indices as [number, number][];
  const sortedIndices = [...indices].sort((a, b) => a[0] - b[0]);

  const mergedIndices: [number, number][] = [];
  for (const [start, end] of sortedIndices) {
    const last = mergedIndices[mergedIndices.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      mergedIndices.push([start, end]);
    }
  }

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const [start, end] of mergedIndices) {
    if (start > lastIndex) {
      parts.push(<span key={`t-${lastIndex}`}>{text.slice(lastIndex, start)}</span>);
    }
    parts.push(
      <mark key={`h-${start}`} className={highlightClassName}>
        {text.slice(start, end + 1)}
      </mark>
    );
    lastIndex = end + 1;
  }

  if (lastIndex < text.length) {
    parts.push(<span key={`t-${lastIndex}`}>{text.slice(lastIndex)}</span>);
  }

  return <>{parts}</>;
}
