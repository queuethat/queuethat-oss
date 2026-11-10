import { Component, type ReactNode } from 'react';

/**
 * Renders nothing if its children throw, typically a lazy chunk that could not load because the
 * phone went offline. For optional extras on a live page (the QR, the place card): losing them
 * must never take the page down.
 */
export class QuietBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}
