import { createFileRoute, redirect } from '@tanstack/react-router';

// app.queuethat.com is the application, not the marketing site (queuethat.com). `/` is the front
// door: /staff's guard sends signed-out visitors to sign-in and new accounts to onboarding.
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/staff', replace: true });
  },
});
