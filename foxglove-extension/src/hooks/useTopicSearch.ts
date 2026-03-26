import { useState, useMemo, useEffect, useRef } from "react";
import Fuse, { type Expression, type FuseResultMatch } from "fuse.js";

interface Topic {
  name: string;
  schemaName?: string;
}

const SEARCH_KEYS = ["name", "schemaName"] as const;
const MIN_SEARCH_WORD_LENGTH = 2;
const TOKEN_REGEX = /[A-Za-z0-9]+/g;
const MAX_FUZZY_SPAN_OVERAGE = 2;

type MatchRange = [number, number];
type SearchKey = (typeof SEARCH_KEYS)[number];

export interface SearchResult {
  item: Topic;
  matches: readonly FuseResultMatch[];
}

interface UseTopicSearchOptions {
  topics: readonly Topic[];
  debounceMs?: number;
}

function getSearchWords(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((word) => word.length >= MIN_SEARCH_WORD_LENGTH)
    .map((word) => word.toLowerCase());
}

function buildWordExpression(word: string): Expression {
  return {
    $or: SEARCH_KEYS.map((key) => ({ [key]: word })),
  };
}

function buildTopicSearchExpression(words: readonly string[]): Expression {
  return {
    $and: words.map((word) => buildWordExpression(word)),
  };
}

function mergeIndices(indices: readonly MatchRange[]): MatchRange[] {
  if (indices.length === 0) {
    return [];
  }

  const sortedIndices = [...indices].sort((a, b) => a[0] - b[0]);
  const mergedIndices: MatchRange[] = [];

  for (const [start, end] of sortedIndices) {
    const last = mergedIndices[mergedIndices.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      mergedIndices.push([start, end]);
    }
  }

  return mergedIndices;
}

function getTokenMatches(value: string): RegExpMatchArray[] {
  return Array.from(value.matchAll(TOKEN_REGEX));
}

function getTokenRange(word: string, token: string): MatchRange | null {
  const exactStart = token.indexOf(word);
  if (exactStart >= 0) {
    return [exactStart, exactStart + word.length - 1];
  }

  let wordIndex = 0;
  let firstMatch = -1;
  let lastMatch = -1;

  for (let tokenIndex = 0; tokenIndex < token.length; tokenIndex += 1) {
    if (token[tokenIndex] !== word[wordIndex]) {
      continue;
    }

    if (firstMatch < 0) {
      firstMatch = tokenIndex;
    }

    lastMatch = tokenIndex;
    wordIndex += 1;

    if (wordIndex === word.length) {
      break;
    }
  }

  if (wordIndex !== word.length || firstMatch < 0 || lastMatch < 0) {
    return null;
  }

  const spanLength = lastMatch - firstMatch + 1;
  if (spanLength > word.length + MAX_FUZZY_SPAN_OVERAGE) {
    return null;
  }

  return [firstMatch, lastMatch];
}

function findBestWordMatchInValue(
  value: string,
  word: string
): { range: MatchRange; exact: boolean } | null {
  let bestMatch: { range: MatchRange; exact: boolean } | null = null;

  for (const tokenMatch of getTokenMatches(value)) {
    const token = tokenMatch[0].toLowerCase();
    const localRange = getTokenRange(word, token);
    if (!localRange) {
      continue;
    }

    const start = (tokenMatch.index ?? 0) + localRange[0];
    const end = (tokenMatch.index ?? 0) + localRange[1];
    const candidate = {
      range: [start, end] as MatchRange,
      exact: token.includes(word),
    };

    if (!bestMatch) {
      bestMatch = candidate;
      continue;
    }

    if (candidate.exact && !bestMatch.exact) {
      bestMatch = candidate;
      continue;
    }

    const bestSpan = bestMatch.range[1] - bestMatch.range[0];
    const candidateSpan = candidate.range[1] - candidate.range[0];
    if (candidate.exact === bestMatch.exact && candidateSpan < bestSpan) {
      bestMatch = candidate;
      continue;
    }

    if (
      candidate.exact === bestMatch.exact &&
      candidateSpan === bestSpan &&
      candidate.range[0] < bestMatch.range[0]
    ) {
      bestMatch = candidate;
    }
  }

  return bestMatch;
}

function buildHighlightMatches(
  topic: Topic,
  words: readonly string[]
): readonly FuseResultMatch[] | null {
  const matchesByKey = new Map<SearchKey, MatchRange[]>();

  for (const word of words) {
    let bestMatch: { key: SearchKey; range: MatchRange; exact: boolean } | null =
      null;

    for (const key of SEARCH_KEYS) {
      const value = topic[key];
      if (!value) {
        continue;
      }

      const match = findBestWordMatchInValue(value, word);
      if (!match) {
        continue;
      }

      if (!bestMatch || (match.exact && !bestMatch.exact)) {
        bestMatch = { key, range: match.range, exact: match.exact };
        continue;
      }

      const bestSpan = bestMatch.range[1] - bestMatch.range[0];
      const candidateSpan = match.range[1] - match.range[0];
      if (
        match.exact === bestMatch.exact &&
        candidateSpan < bestSpan
      ) {
        bestMatch = { key, range: match.range, exact: match.exact };
      }
    }

    if (!bestMatch) {
      return null;
    }

    const existing = matchesByKey.get(bestMatch.key) ?? [];
    existing.push(bestMatch.range);
    matchesByKey.set(bestMatch.key, existing);
  }

  return SEARCH_KEYS.flatMap((key) => {
    const indices = matchesByKey.get(key);
    if (!indices || indices.length === 0) {
      return [];
    }

    return [{ key, indices: mergeIndices(indices) } satisfies FuseResultMatch];
  });
}

function getSearchResults(
  topics: readonly Topic[],
  fuse: Fuse<Topic>,
  query: string
): SearchResult[] {
  if (!query.trim()) {
    return topics.map((topic) => ({ item: topic, matches: [] }));
  }

  const words = getSearchWords(query);
  if (words.length === 0) {
    return topics.map((topic) => ({ item: topic, matches: [] }));
  }

  return fuse
    .search(buildTopicSearchExpression(words))
    .flatMap((result) => {
      const matches = buildHighlightMatches(result.item, words);
      if (!matches) {
        return [];
      }

      return [{
        item: result.item,
        matches,
      } satisfies SearchResult];
    });
}

function createTopicFuse(topics: readonly Topic[]): Fuse<Topic> {
  return new Fuse(topics, {
    keys: [...SEARCH_KEYS],
    threshold: 0.35,
    includeMatches: true,
    ignoreLocation: true,
    minMatchCharLength: MIN_SEARCH_WORD_LENGTH,
    findAllMatches: false,
  });
}

export function searchTopics(
  topics: readonly Topic[],
  query: string
): SearchResult[] {
  return getSearchResults(topics, createTopicFuse(topics), query);
}

export function useTopicSearch({
  topics,
  debounceMs = 150,
}: UseTopicSearchOptions) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => {
      setDebouncedQuery(query);
    }, debounceMs);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [query, debounceMs]);

  const fuse = useMemo(() => createTopicFuse(topics), [topics]);

  const results = useMemo<SearchResult[]>(
    () => getSearchResults(topics, fuse, debouncedQuery),
    [fuse, debouncedQuery, topics]
  );

  return {
    query,
    setQuery,
    debouncedQuery,
    results,
    resultCount: results.length,
    totalCount: topics.length,
  };
}
