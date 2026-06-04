import './FolderBrowser.css';
import { useCallback, useEffect, useState } from 'react';
import type { BrowseEntry, BrowseResult } from '@horizon/sdk';
import { Button } from '../Button/Button.tsx';

export type LibraryTag = 'movies' | 'shows';

export interface FolderBrowserProps {
  /** Lists immediate child folders of `path`; with no path, lists the filesystem root. */
  browse: (path?: string) => Promise<BrowseResult>;
  /** Called when the user assigns the current folder to a library kind. */
  onPick: (path: string, tag: LibraryTag) => void;
  className?: string;
}

interface Crumb {
  name: string;
  path: string;
}

export function FolderBrowser({ browse, onPick, className }: FolderBrowserProps) {
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

  const classes = ['hz-folder-browser', className].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      <nav className="hz-folder-browser__breadcrumb" aria-label="Folder path">
        <button
          type="button"
          className="hz-folder-browser__crumb"
          onClick={goToRoot}
          disabled={crumbs.length === 0}
        >
          Root
        </button>
        {crumbs.map((crumb, index) => (
          <span key={crumb.path} className="hz-folder-browser__crumb-segment">
            <span className="hz-folder-browser__crumb-sep" aria-hidden="true">
              /
            </span>
            <button
              type="button"
              className="hz-folder-browser__crumb"
              onClick={() => goToCrumb(index)}
              disabled={index === crumbs.length - 1}
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </nav>

      {error ? (
        <div className="hz-folder-browser__message" role="alert">
          {error}
        </div>
      ) : loading ? (
        <div className="hz-folder-browser__message">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="hz-folder-browser__message">No subfolders here.</div>
      ) : (
        <ul className="hz-folder-browser__list">
          {entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className="hz-folder-browser__entry"
                onClick={() => openEntry(entry)}
              >
                <span className="hz-folder-browser__entry-icon" aria-hidden="true">
                  📁
                </span>
                <span className="hz-folder-browser__entry-name">{entry.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="hz-folder-browser__actions">
        <span className="hz-folder-browser__current" title={path ?? undefined}>
          {path ?? 'Select a folder to begin'}
        </span>
        <div className="hz-folder-browser__assign">
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
