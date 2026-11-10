import { createFileRoute } from '@tanstack/react-router';
import { SecurityPage } from '../../../features/auth/mfa/SecurityPage.tsx';

export const Route = createFileRoute('/admin/account/security')({
  component: SecurityPage,
});
