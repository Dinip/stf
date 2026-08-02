// Safe wrappers around localStorage + JSON.
//
// localStorage.getItem() returns null for a key that was never written, and
// JSON.parse(null) returns null rather than throwing. Callers that immediately
// did deviceFilters[0] / deviceData.findIndex(...) on the result therefore blew
// up on any browser profile with clean storage. These helpers always hand back
// a usable value.

// Returns the parsed value for `key`, or `fallback` if the key is missing,
// holds invalid JSON, or holds a JSON null.
function getJSON(key, fallback) {
  if (arguments.length < 2) {
    fallback = null
  }

  var raw
  try {
    raw = localStorage.getItem(key)
  } catch (e) {
    // Private mode / storage disabled.
    return fallback
  }

  if (raw === null || raw === undefined || raw === '') {
    return fallback
  }

  var parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return fallback
  }

  return parsed === null || parsed === undefined ? fallback : parsed
}

// Same as getJSON(), but guarantees an Array. Anything else (object, string,
// number) is treated as absent.
function getArray(key) {
  var value = getJSON(key, null)
  return Array.isArray(value) ? value : []
}

function setJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (e) {
    // Quota exceeded or storage disabled; persistence is best-effort.
  }
}

function remove(key) {
  try {
    localStorage.removeItem(key)
  } catch (e) {
    // Ignore.
  }
}

module.exports = {
  getJSON: getJSON
, getArray: getArray
, setJSON: setJSON
, remove: remove
}
