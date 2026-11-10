import { FormEditor, type EditorProps } from './FormEditor.tsx';

/**
 * The one place the forms page mounts an editor. The drag-and-drop builder (B2,
 * `features/admin/forms/builder/*`) replaces the element returned here; the page and the
 * props stay the same.
 */
export function EditorMount(props: EditorProps) {
  return <FormEditor {...props} />;
}
