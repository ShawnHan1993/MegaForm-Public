import MarkdownContent from './MarkdownContent';
import { toInlineLatexPreview } from '../utils/referenceText';

export default function ReferencePreview({ text }: { text: string }) {
  return (
    <span className="collapsed-reference-text">
      <MarkdownContent content={toInlineLatexPreview(text)} inline />
    </span>
  );
}
