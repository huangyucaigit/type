import React from 'react';
export const cn = (...values) => values.filter(Boolean).join(' ');
const paths = {
  close: 'm6 6 12 12M18 6 6 18', expand: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  shrink: 'M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5',
  clear: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  send: 'M12 20V4m-6 6 6-6 6 6', copy: 'M9 9h12v12H9zM5 15H3V3h12v2',
  check: 'm5 12 4 4L19 6', gift: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
};
export function Icon({ name }) { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name] || paths.gift}/></svg>; }
