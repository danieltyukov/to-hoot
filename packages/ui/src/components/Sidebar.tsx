import { useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
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
  onAddProject?: ((title: string) => void) | undefined;
  onAddTag?: ((title: string) => void) | undefined;
  /** The consistency grid sits here. */
  footer?: ReactNode;
}

export function Sidebar({
  projects,
  tags,
  active,
  onSelect,
  counts = {},
  onAddProject,
  onAddTag,
  footer,
}: SidebarProps) {
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

      {/*
        The headings show even with nothing under them, which an earlier version
        did not. They carry the only way to make the first project or the first
        tag, and a section that hides until it has contents can never get any.
      */}
      <Section heading="Projects" label="project" onAdd={onAddProject}>
        {projects.length === 0 ? (
          <li className="nav-none">No projects yet.</li>
        ) : (
          projects.map(p => item(`project:${p.id}`, p.title, p.color))
        )}
      </Section>

      <Section heading="Tags" label="tag" onAdd={onAddTag} className="nav-tags">
        {tags.length === 0 ? (
          <li className="nav-none">No tags yet.</li>
        ) : (
          tags.map(t => (
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
          ))
        )}
      </Section>

      {footer === undefined ? null : <div className="sidebar-foot">{footer}</div>}
    </nav>
  );
}

/** A heading, an add control, and the list. The add control is what makes it a section. */
function Section({
  heading,
  label,
  onAdd,
  className,
  children,
}: {
  heading: string;
  /** The singular noun, for the control names: "New project", "New tag name". */
  label: string;
  onAdd?: ((title: string) => void) | undefined;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const trimmed = title.trim();
    if (trimmed === '' || onAdd === undefined) return;
    onAdd(trimmed);
    setTitle('');
    setOpen(false);
  };

  return (
    <>
      <div className="nav-head-row">
        <h2 className="micro nav-head">{heading}</h2>
        {onAdd === undefined ? null : (
          <button
            type="button"
            className="nav-add"
            aria-label={`New ${label}`}
            aria-expanded={open}
            onClick={() => setOpen(o => !o)}
          >
            <PlusGlyph />
          </button>
        )}
      </div>

      {open ? (
        <form className="nav-new" onSubmit={submit}>
          <input
            className="nav-new-input"
            aria-label={`New ${label} name`}
            placeholder={`${heading.slice(0, -1)} name`}
            value={title}
            autoFocus
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                setTitle('');
                setOpen(false);
              }
            }}
          />
        </form>
      ) : null}

      <ul className={className === undefined ? 'nav' : `nav ${className}`}>{children}</ul>
    </>
  );
}

function PlusGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M8 3.5 V12.5 M3.5 8 H12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
