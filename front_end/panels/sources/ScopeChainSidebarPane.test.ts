// Copyright 2026 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {assert} from 'chai';
import sinon from 'sinon';

import * as SDK from '../../core/sdk/sdk.js';
import * as Protocol from '../../generated/protocol.js';
import * as Bindings from '../../models/bindings/bindings.js';
import * as StackTrace from '../../models/stack_trace/stack_trace.js';
import * as Workspace from '../../models/workspace/workspace.js';
import {assertScreenshot, raf, renderElementIntoDOM} from '../../testing/DOMHelpers.js';
import {describeWithEnvironment} from '../../testing/EnvironmentHelpers.js';
import {MockDebuggerBackend, parseScopeChain} from '../../testing/MockScopeChain.js';
import {createViewFunctionStub} from '../../testing/ViewFunctionHelpers.js';
import * as ObjectUI from '../../ui/legacy/components/object_ui/object_ui.js';
import * as UI from '../../ui/legacy/legacy.js';
import {render} from '../../ui/lit/lit.js';

import * as Sources from './sources.js';

describeWithEnvironment('ScopeChainSidebarPane', () => {
  let backend: MockDebuggerBackend;
  let target: SDK.Target.Target;

  beforeEach(() => {
    const workspace = Workspace.Workspace.WorkspaceImpl.instance();
    const targetManager = SDK.TargetManager.TargetManager.instance();
    const resourceMapping = new Bindings.ResourceMapping.ResourceMapping(targetManager, workspace);
    const ignoreListManager = Workspace.IgnoreListManager.IgnoreListManager.instance({forceNew: true});
    Bindings.DebuggerWorkspaceBinding.DebuggerWorkspaceBinding.instance({
      forceNew: true,
      resourceMapping,
      targetManager,
      ignoreListManager,
      workspace,
    });

    backend = new MockDebuggerBackend();
    target = backend.createTarget();
  });

  it('renders correctly with scope entries', async () => {
    const source = 'function f(a) { debugger } f(1)';
    const scopes = '          {              }';
    parseScopeChain(scopes);  // Verify it parses

    const functionScopeObject = backend.createSimpleRemoteObject([{name: 'a', value: 1}]);
    const callFrame = await backend.createCallFrame(
        target, {url: 'file:///tmp/example.js', content: source}, scopes, null, [functionScopeObject]);

    const pane = Sources.ScopeChainSidebarPane.ScopeChainSidebarPane.instance();
    renderElementIntoDOM(pane, {includeCommonStyles: true});

    const debuggableFrame: StackTrace.StackTrace.DebuggableFrame = {
      sdkFrame: callFrame,
      line: 0,
      column: 0,
    };

    const flavor = StackTrace.StackTrace.DebuggableFrameFlavor.for(debuggableFrame);

    const populateSpy =
        sinon.spy(ObjectUI.ObjectPropertiesSection.ObjectPropertyTreeElement, 'populateChildrenIfNeeded');

    pane.flavorChanged(flavor);
    await pane.updateComplete;

    // Object properties are rendered asynchronously.
    await populateSpy.returnValues[0];
    await raf();  // Wait for Lit and MutationObserver to tick
    await UI.Widget.Widget.allUpdatesComplete;
    await assertScreenshot('sources/scope-chain-sidebar-pane.png');
  });

  it('shows a deferred module namespace as unevaluated and never runs the module', async () => {
    const source = 'function f(a) { debugger } f(1)';
    const scopes = '          {              }';
    parseScopeChain(scopes);

    const deferredNamespace: Protocol.Runtime.RemoteObject = {
      type: Protocol.Runtime.RemoteObjectType.Object,
      className: 'Deferred Module',
      description: 'Deferred Module',
      objectId: 'DEFERRED_NS' as Protocol.Runtime.RemoteObjectId,
      preview: {
        type: Protocol.Runtime.ObjectPreviewType.Object,
        description: 'Deferred Module',
        overflow: false,
        properties: [
          {name: 'answer', type: Protocol.Runtime.PropertyPreviewType.String},
          {name: '[[ModuleStatus]]', type: Protocol.Runtime.PropertyPreviewType.String, value: 'linked'},
        ],
      },
    };
    const functionScopeObject = backend.createSimpleRemoteObject([{name: 'ns', value: deferredNamespace}]);
    const callFrame = await backend.createCallFrame(
        target, {url: 'file:///tmp/example.js', content: source}, scopes, null, [functionScopeObject]);

    const view = createViewFunctionStub(Sources.ScopeChainSidebarPane.ScopeChainSidebarPane);
    const pane = new Sources.ScopeChainSidebarPane.ScopeChainSidebarPane(undefined, view);
    renderElementIntoDOM(pane.contentElement);

    const flavor = StackTrace.StackTrace.DebuggableFrameFlavor.for({sdkFrame: callFrame, line: 0, column: 0});
    pane.flavorChanged(flavor);

    await view.nextInput;
    while (!view.input.scopeChain) {
      await view.nextInput;
    }

    const {objectTree} = view.input.scopeChain![0];
    const {properties} = await objectTree.populateChildrenIfNeeded();
    const namespaceProperty = properties?.find(({property}) => property.name === 'ns');
    assert.exists(namespaceProperty?.property.value);

    // Showing the scope must not have run the module, and the row must offer to run it explicitly.
    assert.isTrue(SDK.RemoteObject.RemoteObject.isUnevaluatedDeferredModuleNamespace(
        namespaceProperty.property.value));
    const container = document.createElement('div');
    render(ObjectUI.ObjectPropertiesSection.renderPropertyValue(namespaceProperty.property.value,
                                                               /* wasThrown= */ false, /* showPreview= */ true),
           container);
    renderElementIntoDOM(container, {allowMultipleChildren: true});
    await UI.Widget.Widget.allUpdatesComplete;
    await raf();
    assert.include(container.textContent, '<unevaluated>');
    assert.notInclude(container.textContent, 'answer');
    assert.exists(container.querySelector('.object-value-calculate-value-button'));
  });

  it('validates object property widgets are not readonly', async () => {
    const source = 'function f(a) { debugger } f(1)';
    const scopes = '          {              }';
    parseScopeChain(scopes);

    const functionScopeObject = backend.createSimpleRemoteObject([{name: 'a', value: 1}]);
    const callFrame = await backend.createCallFrame(
        target, {url: 'file:///tmp/example.js', content: source}, scopes, null, [functionScopeObject]);

    const view = createViewFunctionStub(Sources.ScopeChainSidebarPane.ScopeChainSidebarPane);
    const pane = new Sources.ScopeChainSidebarPane.ScopeChainSidebarPane(undefined, view);
    renderElementIntoDOM(pane.contentElement);

    const debuggableFrame: StackTrace.StackTrace.DebuggableFrame = {
      sdkFrame: callFrame,
      line: 0,
      column: 0,
    };

    const flavor = StackTrace.StackTrace.DebuggableFrameFlavor.for(debuggableFrame);

    pane.flavorChanged(flavor);

    await view.nextInput;
    // Wait for the scope chain update to trigger the view update.
    while (!view.input.scopeChain) {
      await view.nextInput;
    }

    const {scopeChain} = view.input;
    assert.isNotNull(scopeChain);
    const localScope = scopeChain![0];
    assert.isFalse(localScope.objectTree.readOnly);
  });
});
