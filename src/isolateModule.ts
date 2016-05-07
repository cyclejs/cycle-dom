import {VNode} from 'snabbdom';
import {EventDelegator} from './EventDelegator';

export class IsolateModule {
  private eventDelegators = new Map<string, Array<EventDelegator>>();
  constructor (private isolatedElements: Map<string, Element>) {
  }

  private setScope(elm: Element, scope: string) {
    this.isolatedElements.set(scope, elm);
  }

  private removeScope(scope: string) {
    this.isolatedElements.delete(scope);
  }

  getIsolatedElement(scope: string) {
    return this.isolatedElements.get(scope);
  }

  isIsolatedElement(elm: Element): string | boolean {
    const elements = Array.from(this.isolatedElements.entries());
    for (let i = 0; i < elements.length; ++i) {
      if (elm === elements[i][1]) {
        return elements[i][0];
      }
    }
    return false;
  }

  addEventDelegator(scope: string, eventDelegator: EventDelegator) {
    let delegators = this.eventDelegators.get(scope);
    delegators[delegators.length] = eventDelegator;
  }

  reset() {
    this.isolatedElements.clear();
  }

  createModule() {
    const self = this;
    return {
      create(oldVNode: VNode, vNode: VNode) {
        const {data: oldData = {}} = oldVNode;
        const {elm, data = {}} = vNode;
        const oldIsolate = oldData.isolate || ``;
        const isolate = data.isolate || ``;
        if (isolate) {
          if (oldIsolate) { self.removeScope(oldIsolate); }
          self.setScope(elm, isolate);
          const delegators = self.eventDelegators.get(isolate);
          if (delegators) {
            for (let i = 0, len = delegators.length; i < len; ++i) {
              delegators[i].updateTopElement(elm);
            }
          } else if (delegators === void 0) {
            self.eventDelegators.set(isolate, []);
          }
        }
        if (oldIsolate && !isolate) {
          self.removeScope(isolate);
        }
      },

      update(oldVNode: VNode, vNode: VNode) {
        const {data: oldData = {}} = oldVNode;
        const {elm, data = {}} = vNode;
        const oldIsolate = oldData.isolate || ``;
        const isolate = data.isolate || ``;
        if (isolate) {
          if (oldIsolate) { self.removeScope(oldIsolate); }
          self.setScope(elm, isolate);
        }
        if (oldIsolate && !isolate) {
          self.removeScope(isolate);
        }
      },

      remove({data = {}}, cb: Function) {
        const scope = (<any> data).isolate;
        if (scope) {
          self.removeScope(scope);
          if (self.eventDelegators.get(scope)) {
            self.eventDelegators.set(scope, []);
          }
        }
        cb();
      },

      destroy({data = {}}) {
        const scope = (<any> data).isolate;
        if (scope) {
          self.removeScope(scope);
          if (self.eventDelegators.get(scope)) {
            self.eventDelegators.set(scope, []);
          }
        }
      }
    };
  }

  // snabbdom module stuff
}
