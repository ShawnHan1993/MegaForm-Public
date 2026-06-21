import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import VisualTooltip from './components/VisualTooltip';
import './index.css';
import 'katex/dist/katex.min.css';

// lightningcss in the current Vite stack does not yet parse the Custom Highlight
// pseudo-element, so keep this tiny browser-native rule out of the CSS minifier.
const highlightStyle = document.createElement('style');
highlightStyle.textContent = `
::highlight(selection-tooltip-highlight) {
  background-color: #d0dcec;
  color: #455587;
}
`;
document.head.appendChild(highlightStyle);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <VisualTooltip />
  </React.StrictMode>,
);
