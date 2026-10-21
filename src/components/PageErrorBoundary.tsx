import React from 'react';
import { RotateCw } from 'lucide-react';

interface Props {
  /** When this changes (the learner went to another page), a caught error is cleared. */
  resetKey: string;
  children: React.ReactNode;
}

interface State {
  error: unknown;
}

/**
 * Keeps the app on screen when a page fails, most often because a lazy page's chunk did not load
 * after a deploy. Without it React unmounts everything and the tab goes blank.
 */
export class PageErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error ?? new Error('Unknown error') };
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="px-4 sm:px-6 py-8 max-w-prose space-y-3">
        <h1 className="text-2xl font-semibold text-text">This page did not load</h1>
        <p className="text-[15px] text-muted">
          The app may have been updated since you opened it. Reload to get the latest version. Your progress is saved in
          this browser.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-2 h-10 px-4 rounded-md bg-accent text-accent-fg text-sm font-medium hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <RotateCw className="w-4 h-4" aria-hidden="true" />
          Reload
        </button>
      </div>
    );
  }
}
