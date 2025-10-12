(function () {
  const CONFIG = {
    minQueryLength: 3,
    debounceDelay: 350,
  };

  const LABELS = {
    name: ['name', 'nom', 'naam'],
    vat_number: ['vat number', 'numero de tva', 'numéro de tva', 'btw-nummer', 'btw nummer'],
    address1: ['street', 'rue', 'straat'],
    address2: ['apt/suite', 'appt/batiment', 'appt/bâtiment', 'appartement/busnr.', 'appartement/busnr', 'apt'],
    city: ['city', 'ville', 'stad'],
    postal_code: ['postal code', 'code postal', 'postcode'],
    country: ['country', 'pays', 'land'],
  };

  const state = {
    mounted: false,
    container: null,
    resultsList: null,
    infoMessage: null,
    pendingController: null,
    activeAnchor: null,
    suppressSearch: false,
  };

  const styles = {
    container: 'company-lookup__container absolute z-50 bg-white border border-gray-200 rounded-md shadow-lg mt-2 w-full',
    list: 'company-lookup__results max-h-64 overflow-y-auto',
    listItem: 'company-lookup__result block w-full px-3 py-2 hover:bg-gray-100 cursor-pointer text-sm text-left',
    listItemMeta: 'block text-xs text-gray-500',
    info: 'company-lookup__info px-3 py-2 text-xs text-gray-500',
    badge: 'ml-2 inline-flex items-center rounded bg-gray-200 px-2 py-0.5 text-[10px] font-medium text-gray-700',
  };

  const fieldRefs = {};
  const fieldFallbacks = {};
  const fieldElementKey = new WeakMap();

  function debounce(fn, delay) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn.apply(null, args), delay);
    };
  }

  function ensureContainerFor(target) {
    if (state.container) {
      const parentSection = target.closest('section') || target.parentElement;
      if (parentSection && !state.container.parentElement?.isSameNode(parentSection)) {
        parentSection.appendChild(state.container);
      }
      return state.container;
    }

    const parentSection = target.closest('section') || target.parentElement;
    if (!parentSection) {
      return null;
    }

    state.container = document.createElement('div');
    state.container.className = 'relative mt-2';
    state.resultsList = document.createElement('div');
    state.resultsList.className = styles.list;
    state.infoMessage = document.createElement('div');
    state.infoMessage.className = styles.info;
    state.infoMessage.textContent = 'Start typing a VAT number to search.';

    const dropdown = document.createElement('div');
    dropdown.className = styles.container;
    dropdown.appendChild(state.infoMessage);
    dropdown.appendChild(state.resultsList);
    dropdown.style.display = 'none';

    parentSection.appendChild(state.container);
    state.container.appendChild(dropdown);

    return state.container;
  }

  function showContainer() {
    if (!state.container) return;
    const dropdown = state.container.querySelector('.company-lookup__container');
    if (dropdown) dropdown.style.display = 'block';
  }

  function hideContainer() {
    if (!state.container) return;
    const dropdown = state.container.querySelector('.company-lookup__container');
    if (dropdown) dropdown.style.display = 'none';
  }

  function clearResults() {
    if (!state.resultsList) return;
    state.resultsList.innerHTML = '';
  }

  function setInfoMessage(message) {
    if (!state.infoMessage) return;
    state.infoMessage.textContent = message;
    state.infoMessage.style.display = message ? 'block' : 'none';
  }

  function inferenceToken() {
    const candidates = [
      'X-API-TOKEN',
      'X-NINJA-TOKEN',
      'token',
      'api_token',
      'X-Ninja-Token',
    ];
    for (const key of candidates) {
      const value = window.localStorage.getItem(key) || window.sessionStorage.getItem(key);
      if (value) {
        return value;
      }
    }
    return null;
  }

  async function requestLookup(query) {
    if (state.pendingController) {
      state.pendingController.abort();
    }

    state.pendingController = new AbortController();

    if (window.axios) {
      return window.axios
        .get('/api/v1/company-lookup', {
          params: { query },
          signal: state.pendingController.signal,
        })
        .then((response) => response.data.data);
    }

    const token = inferenceToken();
    const headers = {
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json',
    };

    if (token) {
      headers['X-API-TOKEN'] = token;
    }

    const response = await fetch(`/api/v1/company-lookup?${new URLSearchParams({ query }).toString()}`, {
      method: 'GET',
      headers,
      credentials: 'same-origin',
      signal: state.pendingController.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || 'Lookup failed');
    }

    const payload = await response.json();
    return payload.data;
  }

  function getReactProps(element) {
    const keys = Object.keys(element);
    const reactKey = keys.find((key) => key.startsWith('__reactProps$'));
    return reactKey ? element[reactKey] : null;
  }

  function updateReactField(element, value) {
    if (!element) return;

    const normalizedValue = value ?? '';
    element.value = normalizedValue;
    if ('defaultValue' in element) {
      element.defaultValue = normalizedValue;
    }

    const reactProps = getReactProps(element);

    const syntheticEvent = {
      target: element,
      currentTarget: element,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      isTrusted: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
      persist() {},
      nativeEvent: {
        target: element,
        currentTarget: element,
      },
    };

    if (reactProps?.onChange) {
      reactProps.onChange(syntheticEvent);
    } else {
      element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    }

    if (reactProps?.onBlur) {
      reactProps.onBlur(syntheticEvent);
    } else {
      element.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
    }
  }

  function applyResult(result) {
    state.suppressSearch = true;
    const anchor = state.activeAnchor;
    const anchorKey = anchor ? fieldElementKey.get(anchor) : null;
    const handledKeys = new Set();

    if (anchor && anchorKey && result[anchorKey]) {
      updateReactField(anchor, result[anchorKey] ?? '');
      handledKeys.add(anchorKey);
    }

    const values = {
      name: result.name ?? '',
      vat_number: result.vat_number ?? '',
      address1: result.address?.line1 ?? '',
      address2: result.address?.line2 ?? '',
      postal_code: result.address?.postal_code ?? '',
      city: result.address?.city ?? '',
    };

    Object.entries(values).forEach(([key, value]) => {
      if (handledKeys.has(key)) return;
      if (!value) return;
      const element = locateFieldElement(key);
      if (!element) return;
      updateReactField(element, value);
    });

    setTimeout(() => {
      state.suppressSearch = false;
    }, CONFIG.debounceDelay);
  }

  function renderResults(results) {
    if (!state.resultsList) return;

    clearResults();

    if (!results || results.length === 0) {
      setInfoMessage('No matches found.');
      showContainer();
      return;
    }

    setInfoMessage('');

    results.forEach((result) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = styles.listItem;
      item.innerHTML = `
        <span>${result.name ?? 'Unknown company'}<span class="${styles.badge}">${result.source ?? 'lookup'}</span></span>
        <span class="${styles.listItemMeta}">${result.vat_number ?? ''}</span>
        <span class="${styles.listItemMeta}">${result.address?.line1 ?? ''}</span>
        <span class="${styles.listItemMeta}">${[result.address?.postal_code, result.address?.city].filter(Boolean).join(' ')}</span>
      `;

      item.addEventListener('click', () => {
        applyResult(result);
        hideContainer();
      });

      state.resultsList.appendChild(item);
    });

    showContainer();
  }

  async function handleSearch(query) {
    if (query.length < CONFIG.minQueryLength) {
      clearResults();
      setInfoMessage('Keep typing to search by VAT number.');
      return;
    }

    try {
      setInfoMessage('Searching…');
      renderResults([]);

      const { results } = await requestLookup(query);
      renderResults(results);
    } catch (error) {
      setInfoMessage('Lookup failed. Try again or enter details manually.');
      console.warn('[CompanyLookup]', error);
    }
  }

  const debouncedSearch = debounce(handleSearch, CONFIG.debounceDelay);

  function normalizeLabel(value) {
    return value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[:*]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function matchLabel(label) {
    const normalized = normalizeLabel(label);
    for (const [key, values] of Object.entries(LABELS)) {
      if (values.some((value) => normalizeLabel(value) === normalized)) {
        return key;
      }
    }

    return null;
  }

  function registerField(key, element, normalizedLabel) {
    if (!element) return;
    fieldElementKey.set(element, key);

    const descriptor = `${element.getAttribute('name') || ''} ${element.id || ''}`.toLowerCase();
    const label = normalizedLabel || '';
    const isShipping = descriptor.includes('shipping') || label.includes('shipping');
    const isBilling = descriptor.includes('billing') || label.includes('billing');
    const isContact = descriptor.includes('contact') || label.includes('contact');
    const isClientSpecific = descriptor.includes('client') || label.includes('client') || descriptor.includes('company') || label.includes('company');

    if (isContact) {
      return;
    }

    if (isShipping) {
      if (!fieldFallbacks[key]) {
        fieldFallbacks[key] = element;
      }
      return;
    }

    if (!fieldRefs[key] || isBilling || isClientSpecific) {
      fieldRefs[key] = element;
      return;
    }
  }

  function locateFieldElement(key) {
    if (fieldRefs[key]) {
      return fieldRefs[key];
    }

    scanFields();
    return fieldRefs[key] || fieldFallbacks[key] || null;
  }

  function scanFields() {
    const sections = document.querySelectorAll('div.sm\\:grid');
    sections.forEach((section) => {
      const labelSpan = section.querySelector('dt span');
      const formControl = section.querySelector('input, textarea, select');
      if (!labelSpan || !formControl) return;

      const key = matchLabel(labelSpan.textContent || '');
      if (!key) return;

      registerField(key, formControl, normalizeLabel(labelSpan.textContent || ''));
    });
  }

  function handleDocumentInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;

    if (state.suppressSearch) {
      return;
    }

    let key = fieldElementKey.get(target);
    if (!key) {
      const section = target.closest('div.sm\\:grid');
      if (!section) return;
      const labelSpan = section.querySelector('dt span');
      if (!labelSpan) return;
      const labelText = labelSpan.textContent || '';
      key = matchLabel(labelText);
      if (!key) return;
      registerField(key, target, normalizeLabel(labelText));
    }

    if (key === 'name' || key === 'vat_number') {
      const container = ensureContainerFor(target);
      if (!container) return;
      state.activeAnchor = target;
      debouncedSearch(target.value || '');
    }
  }

  function init() {
    if (state.mounted) return;
    state.mounted = true;

    scanFields();
    document.addEventListener('input', handleDocumentInput, true);
    document.addEventListener('click', (event) => {
      if (!state.container) return;
      if (state.container.contains(event.target)) return;
      hideContainer();
    });

    const observer = new MutationObserver(() => {
      scanFields();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
