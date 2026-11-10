import { PRODUCT_NAME } from '@qm/domain';
import { Mark } from '@qm/ui';
import { Link } from '@tanstack/react-router';

/**
 * The QueueThat lockup at the left of the staff and admin header: the mark, then the name, never
 * stacked. The mark is decorative because the name beside it already names the product. It links
 * to the app's front door (`/staff`); `linked={false}` leaves it as plain text where that link would
 * only bounce back (onboarding).
 */
export function BrandLink({ linked = true }: { linked?: boolean }) {
  const className = 'inline-flex min-h-target items-center gap-3 rounded-control text-fg';
  const lockup = (
    <>
      <Mark size={36} />
      <span className="text-xl font-semibold tracking-[-0.03em]">{PRODUCT_NAME}</span>
    </>
  );
  return linked ? (
    <Link to="/staff" className={className}>
      {lockup}
    </Link>
  ) : (
    <span className={className}>{lockup}</span>
  );
}
