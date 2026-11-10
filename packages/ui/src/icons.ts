/**
 * Icon set for `Icon`. Each icon is a 24x24 stroke path (2px grid stroke, round caps), exported
 * as its own constant so a bundle that imports `Icon` plus three icons ships only those three.
 * Add icons here, never inline `<svg>` in a feature (lint enforces it).
 */
export type IconDef = string;

export const iconCheck: IconDef = 'M5 12.5l4.5 4.5L19 7.5';
export const iconX: IconDef = 'M6 6l12 12M18 6L6 18';
export const iconPlus: IconDef = 'M12 5v14M5 12h14';
export const iconChevronDown: IconDef = 'M6 9l6 6 6-6';
export const iconChevronUp: IconDef = 'M6 15l6-6 6 6';
export const iconChevronRight: IconDef = 'M9 6l6 6-6 6';
export const iconArrowRight: IconDef = 'M5 12h14M13 6l6 6-6 6';
export const iconMenu: IconDef = 'M4 7h16M4 12h16M4 17h16';
export const iconEllipsis: IconDef = 'M5 12h.01M12 12h.01M19 12h.01';
export const iconSearch: IconDef = 'M11 5a6 6 0 100 12 6 6 0 000-12zM20 20l-4.2-4.2';
export const iconHome: IconDef = 'M4 11l8-7 8 7M6 9.5V20h12V9.5';
export const iconList: IconDef = 'M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01';
export const iconCalendar: IconDef = 'M5 6h14v14H5zM5 10h14M9 3v4M15 3v4';
export const iconUsers: IconDef =
  'M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2.5 20c0-3.3 2.9-6 6.5-6s6.5 2.7 6.5 6M16 4.3a3.5 3.5 0 010 6.4M18 14.3c2 .8 3.5 2.7 3.5 5.7';
export const iconUser: IconDef = 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 20c0-3.6 3.6-6 8-6s8 2.4 8 6';
export const iconSliders: IconDef = 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4';
export const iconChart: IconDef = 'M5 20V11M12 20V4M19 20v-6';
export const iconPlug: IconDef = 'M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0zM12 17v4';
export const iconCreditCard: IconDef = 'M3 6h18v12H3zM3 10h18M7 15h3';
export const iconShield: IconDef = 'M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z';
export const iconAlertTriangle: IconDef = 'M12 4l9 16H3zM12 10v4M12 17h.01';
export const iconInfo: IconDef = 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 8h.01';
export const iconClock: IconDef = 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2';
export const iconBell: IconDef = 'M6 17V11a6 6 0 0112 0v6l1.5 2h-15zM10 21h4';
export const iconQr: IconDef = 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v6h-4';
export const iconMonitor: IconDef = 'M3 5h18v12H3zM8 21h8M12 17v4';
export const iconTablet: IconDef = 'M6 3h12v18H6zM11 18h2';
export const iconLink: IconDef =
  'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1';
export const iconCopy: IconDef = 'M9 9h11v11H9zM5 15V4h11';
export const iconTrash: IconDef = 'M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13M10 11v6M14 11v6';
export const iconPencil: IconDef = 'M4 20l1-4L16 5l3 3L8 19zM14 7l3 3';
export const iconLogOut: IconDef = 'M10 4H5v16h5M15 8l4 4-4 4M19 12H9';
export const iconPrinter: IconDef = 'M7 9V4h10v5M7 17H4v-7h16v7h-3M7 14h10v6H7z';
export const iconHelp: IconDef =
  'M12 21a9 9 0 100-18 9 9 0 000 18zM9.5 9.5a2.5 2.5 0 114 2c-.9.6-1.5 1-1.5 2M12 17h.01';
export const iconWifiOff: IconDef =
  'M3 3l18 18M8.5 8.8A12 12 0 003 12M16 11a8 8 0 00-2-1M8.5 15a5 5 0 017 0M12 19h.01';
export const iconCircleCheck: IconDef = 'M12 21a9 9 0 100-18 9 9 0 000 18zM8 12.5l3 3 5-6';
export const iconCircleAlert: IconDef = 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 8v5M12 16h.01';
export const iconRefresh: IconDef = 'M21 12a9 9 0 11-3-6.7M21 4v5h-5';
export const iconAccessibility: IconDef =
  'M12 6a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM5 8.5l7 1.5 7-1.5M12 10v4.5l-3 5.5M12 14.5l3 5.5';
