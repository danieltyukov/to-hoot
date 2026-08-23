import type { CSSProperties, ReactNode } from 'react';
import type { Project, Tag } from '@to-hoot/core';

import { OwlMark } from '../icons/OwlMark.js';
import { Wordmark } from './Wordmark.js';
import './Sidebar.css';

/** "today", "project:<id>" or "tag:<id>". */
export type View = string;

export interface SidebarProps {
  projects: Project[];
  tags: Tag[];
  active: View;
  onSelect: (view: View) => void;
  /** View id to the number of open tasks in it. Absent counts render nothing. */
  counts?: Record<string, number>;
  /** The consistency grid sits here. */
  footer?: ReactNode;
}

export function Sidebar({ projects, tags, active, onSelect, counts = {}, footer }: SidebarProps) {
  const item = (view: View, label: string, color?: string): ReactNode => {
    const count = counts[view];
    return (
      <li key={view}>
        <button
          type="button"
          className="nav-item"
          data-view={view}
          aria-current={active === view ? 'page' : undefined}
          onClick={() => onSelect(view)}
        >
          {color === undefined ? null : (
            <span className="nav-dot" style={{ background: color }} aria-hidden="true" />
          )}
          <span className="nav-label">{label}</span>
          {count === undefined || count === 0 ? null : (
            <span className="nav-count tabular">{count}</span>
          )}
        </button>
      </li>
    );
  };

  return (
    <nav className="sidebar" aria-label="Views">
      <div className="brand">
        {/* The logo, not the icon: it has room here, and 22px is above the size
            where its brow and eyes close up. OwlIcon keeps the 16px cases, the
            favicon and the launcher. The word is right beside it, so the mark
            stays out of the reading order. */}
        <OwlMark size={22} label={null} className="brand-mark" />
        <Wordmark className="brand-word" />
      </div>

      <ul className="nav">{item('today', 'Today')}</ul>

      {projects.length === 0 ? null : (
        <>
          <h2 className="micro nav-head">Projects</h2>
          <ul className="nav">
            {projects.map(p => item(`project:${p.id}`, p.title, p.color))}
          </ul>
        </>
      )}

      {tags.length === 0 ? null : (
        <>
          <h2 className="micro nav-head">Tags</h2>
          <ul className="nav nav-tags">
            {tags.map(t => (
              <li key={t.id}>
                <button
                  type="button"
                  className="tag"
                  data-view={`tag:${t.id}`}
                  aria-current={active === `tag:${t.id}` ? 'page' : undefined}
                  onClick={() => onSelect(`tag:${t.id}`)}
                  style={{ '--tag-color': t.color } as CSSProperties}
                >
                  {t.title}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {footer === undefined ? null : <div className="sidebar-foot">{footer}</div>}
    </nav>
  );
}
