import { createFileRoute, redirect } from '@tanstack/react-router';

// This is the application, not a marketing site. `/` is the front
// door: /staff's guard sends signed-out visitors to sign-in and new accounts to onboarding.
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/staff', replace: true });
  },
});
