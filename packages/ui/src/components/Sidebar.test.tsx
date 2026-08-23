import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Sidebar } from './Sidebar.js';

const PROJECTS = [
  { id: 'p1', title: 'Radio', color: '#3d7350', taskIds: [], isArchived: false },
  { id: 'p2', title: 'House', color: '#b23b32', taskIds: [], isArchived: false },
];
const TAGS = [{ id: 'g1', title: 'errand', color: '#c2603f', taskIds: [] }];

function setup(active = 'today') {
  const onSelect = vi.fn();
  const utils = render(
    <Sidebar
      projects={PROJECTS}
      tags={TAGS}
      active={active}
      onSelect={onSelect}
      counts={{ today: 3, 'project:p1': 2, 'project:p2': 0 }}
      footer={<span>grid</span>}
    />,
  );
  return { ...utils, onSelect };
}

describe('Sidebar', () => {
  it('lists Today, then the projects, then the tags', () => {
    const { container } = setup();
    const views = [...container.querySelectorAll('[data-view]')].map(el =>
      el.getAttribute('data-view'),
    );
    expect(views).toEqual(['today', 'project:p1', 'project:p2', 'tag:g1']);
  });

  it('marks the current view for assistive tech, not only for the eye', () => {
    setup('project:p1');
    expect(screen.getByRole('button', { name: /Radio/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: /Today/ })).not.toHaveAttribute('aria-current');
  });

  it('reports the view that was clicked', async () => {
    const { onSelect } = setup();
    await userEvent.click(screen.getByRole('button', { name: /House/ }));
    expect(onSelect).toHaveBeenCalledWith('project:p2');
  });

  it('shows a count only when there is something to count', () => {
    const { container } = setup();
    const radio = container.querySelector('[data-view="project:p1"]')!;
    const house = container.querySelector('[data-view="project:p2"]')!;
    expect(radio.querySelector('.nav-count')).toHaveTextContent('2');
    // Zero is the same information as no badge, and one of them is quieter.
    expect(house.querySelector('.nav-count')).toBeNull();
  });

  it('keeps the mark out of the reading order beside the word it repeats', () => {
    const { container } = setup();
    expect(container.querySelector('.brand-mark')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('spells the wordmark out of real characters, pupils and all', () => {
    // The two `o`s are split into their own elements so a pupil has something
    // to sit in. The word still has to be one word to anything that reads it:
    // selection, search, and the accessible name are all textContent.
    const { container } = setup();
    const wordmark = container.querySelector('.wordmark')!;
    expect(wordmark.textContent).toBe('to-hoot');
    expect(wordmark.querySelectorAll('.wordmark-eye')).toHaveLength(2);
    for (const eye of wordmark.querySelectorAll('.wordmark-eye')) {
      expect(eye.textContent).toBe('o');
    }
  });

  it('gives every control an accessible name', () => {
    const { container } = setup();
    for (const button of container.querySelectorAll('button')) {
      expect(button).toHaveAccessibleName();
    }
  });

  it('keeps the empty sections, because they carry the only way to fill them', () => {
    // An earlier version hid a section until it had contents, which meant the
    // first project could never be made: the control to make it was inside the
    // section that was waiting for it.
    render(
      <Sidebar
        projects={[]}
        tags={[]}
        active="today"
        onSelect={vi.fn()}
        onAddProject={vi.fn()}
        onAddTag={vi.fn()}
      />,
    );
    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New project' })).toBeInTheDocument();
    expect(screen.getByText('No projects yet.')).toBeInTheDocument();
  });

  it('creates a project from the sidebar', async () => {
    const onAddProject = vi.fn();
    const user = userEvent.setup();
    render(
      <Sidebar projects={[]} tags={[]} active="today" onSelect={vi.fn()} onAddProject={onAddProject} />,
    );

    await user.click(screen.getByRole('button', { name: 'New project' }));
    await user.type(screen.getByLabelText('New project name'), 'Radio{Enter}');

    expect(onAddProject).toHaveBeenCalledWith('Radio');
    // The field closes on success, so the sidebar goes back to being a list.
    expect(screen.queryByLabelText('New project name')).toBeNull();
  });

  it('creates a tag the same way', async () => {
    const onAddTag = vi.fn();
    const user = userEvent.setup();
    render(<Sidebar projects={[]} tags={[]} active="today" onSelect={vi.fn()} onAddTag={onAddTag} />);

    await user.click(screen.getByRole('button', { name: 'New tag' }));
    await user.type(screen.getByLabelText('New tag name'), 'errand{Enter}');

    expect(onAddTag).toHaveBeenCalledWith('errand');
  });

  it('offers no add control where the caller has no handler for it', () => {
    render(<Sidebar projects={[]} tags={[]} active="today" onSelect={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'New project' })).toBeNull();
  });

  it('ignores a blank name rather than making a project called nothing', async () => {
    const onAddProject = vi.fn();
    const user = userEvent.setup();
    render(
      <Sidebar projects={[]} tags={[]} active="today" onSelect={vi.fn()} onAddProject={onAddProject} />,
    );
    await user.click(screen.getByRole('button', { name: 'New project' }));
    await user.type(screen.getByLabelText('New project name'), '   {Enter}');
    expect(onAddProject).not.toHaveBeenCalled();
  });

  it('hosts whatever footer it is given', () => {
    setup();
    expect(screen.getByText('grid')).toBeInTheDocument();
  });
});
