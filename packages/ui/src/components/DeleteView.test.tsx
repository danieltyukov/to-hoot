import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { DeleteView } from './DeleteView.js';

function setup() {
  const onDelete = vi.fn();
  render(
    <DeleteView
      noun="project"
      title="Radio"
      question="Delete Radio and its 2 tasks?"
      onDelete={onDelete}
    />,
  );
  return { onDelete, user: userEvent.setup() };
}

describe('DeleteView', () => {
  it('is one quiet control until it is pressed', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Delete project Radio' })).toBeInTheDocument();
    expect(screen.queryByText('Delete Radio and its 2 tasks?')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete project' })).toBeNull();
  });

  it('deletes nothing on the first press, only asks', async () => {
    const { onDelete, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Delete project Radio' }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText('Delete Radio and its 2 tasks?')).toBeInTheDocument();
  });

  it('puts the focus on Cancel, so a stray Enter keeps the project', async () => {
    const { onDelete, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Delete project Radio' }));

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('deletes once the question is answered', async () => {
    const { onDelete, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Delete project Radio' }));
    await user.click(screen.getByRole('button', { name: 'Delete project' }));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('backs out on Escape and hands the focus back to where it came from', async () => {
    const { onDelete, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Delete project Radio' }));
    await user.keyboard('{Escape}');

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByText('Delete Radio and its 2 tasks?')).toBeNull();
    // Without this the focus falls to the document when the question unmounts,
    // and the next Tab starts from the top of the page.
    expect(screen.getByRole('button', { name: 'Delete project Radio' })).toHaveFocus();
  });

  it('names the question for a screen reader working through the header', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Delete project Radio' }));
    expect(screen.getByRole('group', { name: 'Delete project Radio' })).toBeInTheDocument();
  });
});
