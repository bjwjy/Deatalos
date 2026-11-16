import {
  parseNetworkProject,
  diagnostic,
  type NetworkProject,
  type NetworkTextAnnotation,
  type Result,
} from '@hyd/domain';
export type NetworkTextEdit =
  | { readonly kind: 'put'; readonly value: NetworkTextAnnotation; readonly replace: boolean }
  | { readonly kind: 'delete'; readonly id: string };
/** Layout transaction planning only; the draft owns history, revision and saved state. */
export function planNetworkText(input: unknown, edit: NetworkTextEdit): Result<NetworkProject> {
  const parsed = parseNetworkProject(input);
  if (!parsed.ok) return parsed;
  const project = parsed.value,
    texts = project.layout.texts ?? [];
  const id = edit.kind === 'put' ? edit.value.id : edit.id;
  const found = texts.some((item) => item.id === id);
  if (edit.kind === 'delete' ? !found : edit.replace !== found)
    return {
      ok: false,
      diagnostics: [diagnostic('TEXT_STALE', '/layout/texts', '文本标注已改变，请重新选择后编辑。')],
    };
  return parseNetworkProject({
    ...project,
    layout: {
      ...project.layout,
      texts:
        edit.kind === 'delete'
          ? texts.filter((item) => item.id !== id)
          : found
            ? texts.map((item) => (item.id === id ? edit.value : item))
            : [...texts, edit.value],
    },
  });
}
