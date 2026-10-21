import React from 'react';
import type { Badge } from '../../data/badges';

/** A badge's name: monospace only when it is literally something you type. */
export const BadgeName: React.FC<{ badge: Pick<Badge, 'name' | 'nameIsCommand'>; className?: string }> = ({ badge, className = '' }) =>
  badge.nameIsCommand ? (
    <code className={`font-mono text-[0.95em] ${className}`}>{badge.name}</code>
  ) : (
    <span className={className}>{badge.name}</span>
  );
