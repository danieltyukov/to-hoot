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

  it('drops empty sections rather than showing an empty heading', () => {
    render(<Sidebar projects={[]} tags={[]} active="today" onSelect={vi.fn()} />);
    expect(screen.queryByText('Projects')).toBeNull();
    expect(screen.queryByText('Tags')).toBeNull();
  });

  it('hosts whatever footer it is given', () => {
    setup();
    expect(screen.getByText('grid')).toBeInTheDocument();
  });
});
