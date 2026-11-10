import { createFileRoute } from '@tanstack/react-router';
import { WidgetPage } from '../../features/admin/widget/WidgetPage.tsx';

export const Route = createFileRoute('/admin/widget')({
  component: WidgetPage,
});
