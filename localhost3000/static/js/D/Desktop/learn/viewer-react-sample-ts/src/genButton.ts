export function genLinkButton() {
  const button = new Autodesk.Viewing.UI.Button('button-link-task');
  button.addClass('button-link-task');
  button.setIcon('adsk-button-link');
  button.setToolTip('Link Task');
  return button;
}
