import { useId, useState, type ReactNode } from 'react';
import { Button } from './Button.tsx';
import { Icon } from './Icon.tsx';
import { iconChevronDown, iconChevronUp } from './icons.ts';

export interface DisclosureProps {
  /** The line that stays visible and toggles the section. */
  title: ReactNode;
  children: ReactNode;
  /** Initial state when uncontrolled. */
  defaultOpen?: boolean;
  /** Controlled state; pair it with `onOpenChange`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

/**
 * Progressive disclosure: the content is only rendered while open, so keep its state in the
 * parent when it must survive being closed. The toggle is a 48px button with `aria-expanded`.
 */
export function Disclosure({
  title,
  children,
  defaultOpen = false,
  open,
  onOpenChange,
  className,
}: DisclosureProps) {
  const panelId = useId();
  const [inner, setInner] = useState(defaultOpen);
  const isOpen = open ?? inner;
  const toggle = () => {
    const next = !isOpen;
    if (open === undefined) setInner(next);
    onOpenChange?.(next);
  };
  return (
    <div className={className}>
      <Button
        variant="secondary"
        className="w-full justify-between"
        aria-expanded={isOpen}
        aria-controls={isOpen ? panelId : undefined}
        onClick={toggle}
      >
        <span>{title}</span>
        <Icon icon={isOpen ? iconChevronUp : iconChevronDown} />
      </Button>
      {isOpen ? (
        <div id={panelId} className="flex flex-col gap-4 pt-4">
          {children}
        </div>
      ) : null}
    </div>
  );
}
