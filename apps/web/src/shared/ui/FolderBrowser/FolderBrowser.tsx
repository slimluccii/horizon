import { useCallback, useEffect, useState } from 'react';
import type { BrowseEntry, BrowseResult } from '@horizon/sdk';
import { Button } from '../Button/Button.tsx';

export type LibraryTag = 'movies' | 'shows';

export interface FolderBrowserProps {
  /** Lists immediate child folders of `path`; with no path, lists the filesystem root. */
  browse: (path?: string) => Promise<BrowseResult>;
  /** Called when the user assigns the current folder to a library kind. */
  onPick: (path: string, tag: LibraryTag) => void;
}

interface Crumb {
  name: string;
  path: string;
}

export function FolderBrowser({ browse, onPick }: FolderBrowserProps) {
  // `null` path means "at the filesystem root" (no current folder, cannot go up).
  const [path, setPath] = useState<string | null>(null);
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (next: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const result = await browse(next ?? undefined);
        setEntries(result.entries);
        setPath(next);
      } catch {
        setError('Could not list this folder.');
      } finally {
        setLoading(false);
      }
    },
    [browse],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  function openBase(entry: BrowseEntry) {
    setCrumbs([{ name: entry.name, path: entry.path }]);
    void load(entry.path);
  }

  function openChild(entry: BrowseEntry) {
    setCrumbs((prev) => [...prev, { name: entry.name, path: entry.path }]);
    void load(entry.path);
  }

  function openEntry(entry: BrowseEntry) {
    if (crumbs.length === 0) {
      openBase(entry);
    } else {
      openChild(entry);
    }
  }

  function goToRoot() {
    setCrumbs([]);
    void load(null);
  }

  function goToCrumb(index: number) {
    const target = crumbs[index];
    setCrumbs((prev) => prev.slice(0, index + 1));
    void load(target.path);
  }

  return (
    <div>
      <nav aria-label="Folder path">
        <button
          type="button"
          onClick={goToRoot}
          disabled={crumbs.length === 0}
        >
          Root
        </button>
        {crumbs.map((crumb, index) => (
          <span key={crumb.path}>
            <span aria-hidden="true">
              /
            </span>
            <button
              type="button"
              onClick={() => goToCrumb(index)}
              disabled={index === crumbs.length - 1}
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </nav>

      {error ? (
        <div role="alert">
          {error}
        </div>
      ) : loading ? (
        <div>Loading…</div>
      ) : entries.length === 0 ? (
        <div>No subfolders here.</div>
      ) : (
        <ul>
          {entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                onClick={() => openEntry(entry)}
              >
                <span aria-hidden="true">
                  📁
                </span>
                <span>{entry.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div>
        <span title={path ?? undefined}>
          {path ?? 'Select a folder to begin'}
        </span>
        <div>
          <Button disabled={!path} onClick={() => path && onPick(path, 'movies')}>
            Use for Movies
          </Button>
          <Button disabled={!path} onClick={() => path && onPick(path, 'shows')}>
            Use for Shows
          </Button>
        </div>
      </div>
    </div>
  );
}
