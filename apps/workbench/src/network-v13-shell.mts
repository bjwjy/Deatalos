import { element } from './network-dom.mjs';
import { networkUiIcon, type NetworkUiIcon } from './network-v13-icons.mjs';
import { setupNetworkPressFeedback, setupNetworkToolbarMotion, setupNetworkTooltips } from './network-v13-controls.mjs';
import { setupNetworkDrawer } from './network-v13-drawer.mjs';
import { setupNetworkGlass } from './network-v13-glass.mjs';
import { setupNetworkTheme } from './network-v13-theme.mjs';
import { setupNetworkStatusCardMotion } from './network-v13-status-cards.mjs';
import { setupNetworkOperationVisibility } from './network-v13-operation-feedback.mjs';
import { setupNetworkWhiteDialogs } from './network-v13-dialogs.mjs';
import { setupNetworkLibraryMotion } from './network-v13-library-motion.mjs';
import { setupNetworkShortcutPresentation } from './network-shortcut-presentation.mjs';
/** Appearance/composition only. Existing owners continue to dispatch every command. */
export function setupNetworkWhiteInterface(): void {
  const icons: readonly NetworkUiIcon[] = [
    'document',
    'folder',
    'save',
    'copy',
    'text',
    'undo',
    'redo',
    'pause',
    'step',
    'reset',
    'help',
    'chevron',
    'gear',
  ];
  for (const node of document.querySelectorAll<HTMLElement>('[data-icon],[data-ui-icon]')) {
    const icon = icons.find((name) => name === (node.dataset.icon || node.dataset.uiIcon));
    if (icon) node.innerHTML = networkUiIcon(icon);
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('.menubar>button[popovertarget]'))
    button.classList.add('menu-trigger');
  for (const button of document.querySelectorAll<HTMLButtonElement>('.menu-popup button,.submenu-popup button'))
    button.classList.add('menu-item');
  for (const node of document.querySelectorAll<HTMLElement>('.menu-popup,.submenu-popup')) document.body.append(node);
  const search = element('librarySearch');
  const searchRow = document.createElement('label');
  searchRow.className = 'library-search';
  search.before(searchRow);
  searchRow.innerHTML = networkUiIcon('search');
  searchRow.append(search);
  const curveButtons = document.createElement('div');
  curveButtons.className = 'button-row';
  element('refreshCurvePreview').before(curveButtons);
  curveButtons.append(element('refreshCurvePreview'), element('curveExportSettings'));
  element('refreshCurvePreview').classList.add('button');
  element('curveExportSettings').classList.add('button');
  element('refreshCurvePreview').insertAdjacentHTML('afterbegin', networkUiIcon('reset'));
  element('curve').after(element('curveStatus'));
  element('runStatusPanel').classList.add('run-status');
  const dot = document.createElement('span');
  dot.className = 'state-dot';
  element('runStatusPanel').prepend(dot);

  element('componentTools').classList.add('library-categories');
  for (const panel of element('statusPanels').querySelectorAll<HTMLElement>('.status-panel')) {
    panel.classList.add('status-section');
    panel.dataset.statusSection = panel.dataset.statusPanel;
    const heading = panel.querySelector('h3');
    if (heading) {
      const symbol = document.createElement('span');
      symbol.className = 'section-icon';
      symbol.innerHTML = networkUiIcon(
        panel.dataset.statusPanel === 'run'
          ? 'run'
          : panel.dataset.statusPanel === 'curve'
            ? 'chart'
            : panel.dataset.statusPanel === 'history'
              ? 'history'
              : 'settings',
      );
      heading.prepend(symbol);
    }
  }
  setupNetworkWhiteDialogs();
  setupNetworkPressFeedback();
  setupNetworkToolbarMotion();
  setupNetworkLibraryMotion();
  setupNetworkTooltips();
  setupNetworkDrawer();
  setupNetworkStatusCardMotion();
  setupNetworkShortcutPresentation();
  setupNetworkTheme(setupNetworkGlass());
  setupNetworkOperationVisibility();
}
