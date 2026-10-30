import React from 'react';
import { routeHref } from '../../lib/router';
import { setViewAs, useViewAs } from '../../lib/viewAs';

const LABEL = { 'signed-out': 'a signed-out visitor', learner: 'a learner' } as const;

/** While an admin views the site as someone else: says so, with a way back */
export const ViewAsBanner: React.FC = () => {
  const viewAs = useViewAs();
  if (!viewAs) return null;
  return (
    <p role="status" className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1 px-4 sm:px-6 py-1.5 text-sm bg-warn-soft text-text border-b border-line">
      <span>
        Viewing as {LABEL[viewAs]}. Your own account stays signed in and keeps syncing.
      </span>
      <button
        type="button"
        onClick={() => {
          setViewAs(null);
          window.location.hash = routeHref({ section: 'admin' });
        }}
        className="font-medium text-accent underline-offset-2 hover:underline"
      >
        Stop and go back to the admin dashboard
      </button>
    </p>
  );
};
