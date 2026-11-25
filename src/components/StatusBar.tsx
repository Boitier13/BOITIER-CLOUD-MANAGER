import type { ReactNode } from 'react';

export function StatusBar({
  left,
  right,
}: {
  left?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <footer className="statusbar">
      {left}
      <span className="statusbar__spacer" />
      {right}
      <span className="statusbar__item">
        <span className="statusbar__live" />
        Simulation locale
      </span>
    </footer>
  );
}
