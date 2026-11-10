import { createFileRoute } from '@tanstack/react-router';
import { BrandingPage } from '../../features/admin/branding/BrandingPage.tsx';

export const Route = createFileRoute('/admin/branding')({
  component: BrandingPage,
});
