import React, { useMemo } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTopicSearch } from "@/hooks/useTopicSearch";
import { SearchHighlight } from "./SearchHighlight";

interface Topic {
  name: string;
  schemaName?: string;
}

interface TopicSelectorSectionProps {
  topics: readonly Topic[];
  selectedTopics: Set<string>;
  onToggleTopic: (topic: string) => void;
  onClearAll: () => void;
}

export function TopicSelectorSection({
  topics,
  selectedTopics,
  onToggleTopic,
  onClearAll,
}: TopicSelectorSectionProps): React.ReactElement {
  const { query, setQuery, results, resultCount, totalCount } = useTopicSearch({
    topics,
    debounceMs: 150,
  });

  const selectedList = useMemo(
    () => Array.from(selectedTopics),
    [selectedTopics]
  );

  const availableResults = useMemo(() => {
    return results.filter(({ item }) => !selectedTopics.has(item.name));
  }, [results, selectedTopics]);

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Filter topics by name or type..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9 pr-10"
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            className="absolute right-3 top-2.5 text-muted-foreground hover:text-foreground"
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {query && (
        <p className="text-xs text-muted-foreground">
          Showing {resultCount} of {totalCount} topics
        </p>
      )}

      {selectedList.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">
              Selected Topics{" "}
              <Badge variant="secondary">{selectedList.length}</Badge>
            </h4>
            <Button variant="ghost" size="sm" onClick={onClearAll}>
              Clear all
            </Button>
          </div>
          <div className="max-h-32 space-y-1 overflow-auto rounded-md border p-2">
            {selectedList.map((topic) => {
              const isAvailable = topics.some((t) => t.name === topic);
              return (
                <div
                  key={topic}
                  className="flex items-center justify-between py-1"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Checkbox
                      checked={true}
                      onCheckedChange={() => onToggleTopic(topic)}
                    />
                    <span
                      className={`text-sm truncate ${
                        !isAvailable
                          ? "text-muted-foreground line-through"
                          : ""
                      }`}
                    >
                      {topic}
                    </span>
                    {!isAvailable && (
                      <Badge variant="outline" className="text-xs shrink-0">
                        unavailable
                      </Badge>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    onClick={() => onToggleTopic(topic)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <h4 className="text-sm font-medium">
          {query ? "Search Results" : "Available Topics"}
        </h4>
        <div className="max-h-64 space-y-1 overflow-auto rounded-md border p-2">
          {availableResults.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {query ? "No topics found" : "All topics selected"}
            </p>
          ) : (
            availableResults.map(({ item, matches }) => (
              <div
                key={item.name}
                className="flex items-center gap-2 py-1 px-1 rounded hover:bg-muted"
              >
                <Checkbox
                  checked={false}
                  onCheckedChange={() => onToggleTopic(item.name)}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">
                    <SearchHighlight
                      text={item.name}
                      matches={matches}
                      matchKey="name"
                    />
                  </div>
                  {item.schemaName && (
                    <div className="text-xs text-muted-foreground truncate">
                      <SearchHighlight
                        text={item.schemaName}
                        matches={matches}
                        matchKey="schemaName"
                      />
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
