import { createFileRoute } from '@tanstack/react-router';
import { SignagePage } from '../../features/admin/signage/SignagePage.tsx';

export const Route = createFileRoute('/admin/signage')({
  component: SignagePage,
});
