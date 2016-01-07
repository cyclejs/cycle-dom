let Rx = require(`rx`)
let fromEvent = require(`./fromevent`)
let VDOM = {
  h: require(`./virtual-hyperscript`),
  diff: require(`virtual-dom/diff`),
  patch: require(`virtual-dom/patch`),
  parse: typeof window !== `undefined` ? require(`vdom-parser`) : () => {},
}
let {transposeVTree} = require(`./transposition`)
let matchesSelector
// Try-catch to prevent unnecessary import of DOM-specifics in Node.js env:
try {
  matchesSelector = require(`matches-selector`)
} catch (err) {
  matchesSelector = () => {}
}

function isElement(obj) {
  return typeof HTMLElement === `object` ?
    obj instanceof HTMLElement || obj instanceof DocumentFragment : //DOM2
    obj && typeof obj === `object` && obj !== null &&
    (obj.nodeType === 1 || obj.nodeType === 11) &&
    typeof obj.nodeName === `string`
}

function wrapTopLevelVTree(vtree, rootElem) {
  const {id: vtreeId = ``} = vtree.properties
  const {className: vtreeClass = ``} = vtree.properties
  const sameId = vtreeId === rootElem.id
  const sameClass = vtreeClass === rootElem.className
  const sameTagName = vtree.tagName.toUpperCase() === rootElem.tagName
  if (sameId && sameClass && sameTagName) {
    return vtree
  }
  let attrs = {}
  if (rootElem.id) { attrs.id = rootElem.id }
  if (rootElem.className) { attrs.className = rootElem.className }
  return VDOM.h(rootElem.tagName, attrs, [vtree])
}

function makeDiffAndPatchToElement$(rootElem) {
  return function diffAndPatchToElement$([oldVTree, newVTree]) {
    if (typeof newVTree === `undefined`) { return Rx.Observable.empty() }

    let prevVTree = wrapTopLevelVTree(oldVTree, rootElem)
    let nextVTree = wrapTopLevelVTree(newVTree, rootElem)
    /* eslint-disable */
    rootElem = VDOM.patch(rootElem, VDOM.diff(prevVTree, nextVTree))
    /* eslint-enable */
    return Rx.Observable.just(rootElem)
  }
}

function renderRawRootElem$(vtree$, domContainer) {
  let diffAndPatchToElement$ = makeDiffAndPatchToElement$(domContainer)
  return vtree$
    .flatMapLatest(transposeVTree)
    .startWith(VDOM.parse(domContainer))
    .pairwise()
    .flatMap(diffAndPatchToElement$)
}

function isolateSource(source, scope) {
  return source.select(`.cycle-scope-${scope}`)
}

function isolateSink(sink, scope) {
  return sink.map(vtree => {
    const {className: vtreeClass = ``} = vtree.properties
    if (vtreeClass.indexOf(`cycle-scope-${scope}`) === -1) {
      const c = `${vtreeClass} cycle-scope-${scope}`.trim()
      vtree.properties.className = c
    }
    if (vtree.properties.attributes) { // for svg root elements
      const vtreeAttrClass = vtree.properties.attributes[`class`] || ``
      if (vtreeAttrClass.indexOf(`cycle-scope-${scope}`) === -1) {
        const cattr = `${vtreeAttrClass} cycle-scope-${scope}`.trim()
        vtree.properties.attributes[`class`] = cattr
      }
    }
    return vtree
  })
}

function makeIsStrictlyInRootScope(rootList, namespace) {
  const classIsForeign = c => {
    const matched = c.match(/cycle-scope-(\S+)/)
    return matched && namespace.indexOf(`.${c}`) === -1
  }
  const classIsDomestic = c => {
    const matched = c.match(/cycle-scope-(\S+)/)
    return matched && namespace.indexOf(`.${c}`) !== -1
  }
  return function isStrictlyInRootScope(leaf) {
    for (let el = leaf; el !== null; el = el.parentElement) {
      if (rootList.indexOf(el) >= 0) {
        return true
      }

      const split = String.prototype.split
      const classList = el.classList || split.call(el.className, ` `)
      if (Array.prototype.some.call(classList, classIsDomestic)) {
        return true
      }
      if (Array.prototype.some.call(classList, classIsForeign)) {
        return false
      }
    }
    return true
  }
}

function makeEventsSelector(element$, addEventToHistory) {
  return function events(eventName, useCapture = false) {
    if (typeof eventName !== `string`) {
      throw new Error(`DOM driver's events() expects argument to be a ` +
        `string representing the event type to listen for.`)
    }

    const historyApi = addEventToHistory(eventName)

    element$.flatMapLatest(elements => {
      if (elements.length === 0) {
        return Rx.Observable.empty()
      }
      return fromEvent(elements, eventName, historyApi.add, useCapture)
    }).share().subscribe(historyApi.stream)

    return historyApi.stream
  }
}

function makeElementSelector(rootEl$, addToHistory) {
  return function select(selector) {
    if (typeof selector !== `string`) {
      throw new Error(`DOM driver's select() expects the argument to be a ` +
        `string as a CSS selector`)
    }

    const namespace = this.namespace
    const element$ = selector.trim() === `:root` ? rootEl$ : rootEl$.map(x => {
      const array = Array.isArray(x) ? x : [x]
      return array.map(element => {
        const boundarySelector = `${namespace.join(` `)}${selector}`
        if (matchesSelector(element, boundarySelector)) {
          return [element]
        } else {
          const scopedSelector = `${namespace.join(` `)} ${selector}`.trim()
          const nodeList = element.querySelectorAll(scopedSelector)
          return Array.prototype.slice.call(nodeList)
        }
      })
      .reduce((prev, curr) => prev.concat(curr), [])
      .filter(makeIsStrictlyInRootScope(array, namespace.concat(selector)))
    })

    function additionalSelectorForHistory(otherSelector) {
      return addToHistory(`${selector},${otherSelector}`)
    }

    return {
      observable: element$,
      namespace: namespace.concat(selector),
      select: makeElementSelector(element$, additionalSelectorForHistory),
      events: makeEventsSelector(element$, addToHistory(selector)),
      isolateSource,
      isolateSink,
    }
  }
}

function validateDOMSink(vtree$) {
  if (!vtree$ || typeof vtree$.subscribe !== `function`) {
    throw new Error(`The DOM driver function expects as input an ` +
      `Observable of virtual DOM elements`)
  }
}

function makeDOMDriver(container, options) {
  // Find and prepare the container
  let domContainer = typeof container === `string` ?
    document.querySelector(container) :
    container
  // Check pre-conditions
  if (typeof container === `string` && domContainer === null) {
    throw new Error(`Cannot render into unknown element \`${container}\``)
  } else if (!isElement(domContainer)) {
    throw new Error(`Given container is not a DOM element neither a selector ` +
      `string.`)
  }
  const {onError = console.error.bind(console)} = options || {}
  if (typeof onError !== `function`) {
    throw new Error(`You provided an \`onError\` to makeDOMDriver but it was ` +
      `not a function. It should be a callback function to handle errors.`)
  }

  let history = {}

  function addHistoryEntry(selector) {
    return function addEventToHistory(eventName) {
      if (typeof history[selector] === `undefined`) {
        history[selector] = {}
      }

      if (typeof history[selector][eventName] === `undefined`) {
        history[selector][eventName] = {stream: new Rx.Subject(), events: []}
      }

      function add(event) {
        history[selector][eventName].events.push({event, time: new Date()})
      }

      return {
        add,
        stream: history[selector][eventName].stream,
      }
    }
  }

  function domDriver(vtree$) {
    validateDOMSink(vtree$)
    let rootElem$ = renderRawRootElem$(vtree$, domContainer)
      .startWith(domContainer)
      .doOnError(onError)
      .replay(null, 1)
    let disposable = rootElem$.connect()
    return {
      namespace: [],
      select: makeElementSelector(rootElem$, addHistoryEntry),
      dispose: disposable.dispose.bind(disposable),
      isolateSource,
      isolateSink,
      history: () => history,
    }
  }

  function replayHistory(scheduler, newHistory) {
    function scheduleEvent(stream) {
      return function scheduleEventForStream(historicEvent) {
        scheduler.scheduleAbsolute({}, historicEvent.time, () => {
          stream.onNext(historicEvent.event)
        })
      }
    }

    for (let selector in newHistory) {
      if (newHistory.hasOwnProperty(selector)) {
        const selectorHistory = newHistory[selector]

        for (let eventName in selectorHistory) {
          if (selectorHistory.hasOwnProperty(eventName)) {
            const eventHistory = selectorHistory[eventName]

            eventHistory.events.forEach(scheduleEvent(eventHistory.stream))
          }
        }
      }
    }
  }

  domDriver.replayHistory = replayHistory

  return domDriver
}

module.exports = {
  isElement,
  wrapTopLevelVTree,
  makeDiffAndPatchToElement$,
  renderRawRootElem$,
  validateDOMSink,

  makeDOMDriver,
}
