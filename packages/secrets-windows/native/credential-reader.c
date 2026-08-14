#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wincred.h>
#include <node_api.h>
#include <stdint.h>
#include <stdlib.h>

#define TARGET_MAX_CHARS 128U
#define SECRET_MAX_BYTES 16384U

typedef enum operation_mode {
  MODE_AVAILABILITY = 1,
  MODE_READ = 2
} operation_mode;

typedef enum result_status {
  RESULT_OK = 1,
  RESULT_NOT_FOUND = 2,
  RESULT_ACCESS_DENIED = 3,
  RESULT_UNAVAILABLE = 4,
  RESULT_MALFORMED = 5,
  RESULT_FAILURE = 6
} result_status;

typedef struct credential_work {
  napi_env env;
  napi_async_work work;
  napi_deferred deferred;
  operation_mode mode;
  result_status status;
  wchar_t *target;
  unsigned char *bytes;
  DWORD byte_count;
} credential_work;

static void secure_free(void *value, size_t byte_count) {
  if (value != NULL) {
    if (byte_count > 0U) {
      SecureZeroMemory(value, byte_count);
    }
    HeapFree(GetProcessHeap(), 0U, value);
  }
}

static int is_lower_hex(wchar_t value) {
  return (value >= L'0' && value <= L'9') || (value >= L'a' && value <= L'f');
}

static int target_is_canonical(const wchar_t *target, size_t length) {
  static const wchar_t prefix[] = L"AI-Dev-OS:v1:";
  const size_t prefix_length = (sizeof(prefix) / sizeof(prefix[0])) - 1U;
  size_t index;
  size_t namespace_start;
  size_t namespace_length;
  if (target == NULL || length < prefix_length + 66U || length > TARGET_MAX_CHARS) {
    return 0;
  }
  for (index = 0U; index < prefix_length; index += 1U) {
    if (target[index] != prefix[index]) return 0;
  }
  namespace_start = prefix_length;
  index = namespace_start;
  if (target[index] < L'a' || target[index] > L'z') return 0;
  while (index < length && target[index] != L':') {
    const wchar_t value = target[index];
    if (!((value >= L'a' && value <= L'z') || (value >= L'0' && value <= L'9') || value == L'-')) return 0;
    index += 1U;
  }
  namespace_length = index - namespace_start;
  if (namespace_length < 1U || namespace_length > 32U || index >= length || target[index] != L':') return 0;
  index += 1U;
  if (length - index != 64U) return 0;
  while (index < length) {
    if (!is_lower_hex(target[index])) return 0;
    index += 1U;
  }
  return 1;
}

static result_status map_windows_error(DWORD code) {
  if (code == ERROR_NOT_FOUND) return RESULT_NOT_FOUND;
  if (code == ERROR_ACCESS_DENIED) return RESULT_ACCESS_DENIED;
  if (code == ERROR_NO_SUCH_LOGON_SESSION || code == ERROR_NOT_SUPPORTED || code == ERROR_SERVICE_DISABLED) return RESULT_UNAVAILABLE;
  return RESULT_FAILURE;
}

static void execute_credential_work(napi_env env, void *data) {
  credential_work *request = (credential_work *)data;
  PCREDENTIALW credential = NULL;
  (void)env;
  if (!CredReadW(request->target, CRED_TYPE_GENERIC, 0U, &credential)) {
    request->status = map_windows_error(GetLastError());
    return;
  }
  if (credential == NULL || credential->Type != CRED_TYPE_GENERIC || credential->CredentialBlob == NULL || credential->CredentialBlobSize < 1U || credential->CredentialBlobSize > SECRET_MAX_BYTES) {
    request->status = RESULT_MALFORMED;
  } else if (request->mode == MODE_READ) {
    request->bytes = (unsigned char *)HeapAlloc(GetProcessHeap(), 0U, credential->CredentialBlobSize);
    if (request->bytes == NULL) {
      request->status = RESULT_FAILURE;
    } else {
      CopyMemory(request->bytes, credential->CredentialBlob, credential->CredentialBlobSize);
      request->byte_count = credential->CredentialBlobSize;
      request->status = RESULT_OK;
    }
  } else {
    request->status = RESULT_OK;
  }
  if (credential != NULL) {
    if (credential->CredentialBlob != NULL && credential->CredentialBlobSize > 0U) {
      SecureZeroMemory(credential->CredentialBlob, credential->CredentialBlobSize);
    }
    CredFree(credential);
  }
}

static const char *status_text(result_status status) {
  switch (status) {
    case RESULT_OK: return "ok";
    case RESULT_NOT_FOUND: return "not-found";
    case RESULT_ACCESS_DENIED: return "access-denied";
    case RESULT_UNAVAILABLE: return "unavailable";
    case RESULT_MALFORMED: return "malformed";
    default: return "failure";
  }
}

static napi_status set_named_string(napi_env env, napi_value object, const char *name, const char *value) {
  napi_value text;
  napi_status status = napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &text);
  if (status != napi_ok) return status;
  return napi_set_named_property(env, object, name, text);
}

static void complete_credential_work(napi_env env, napi_status async_status, void *data) {
  credential_work *request = (credential_work *)data;
  napi_value result;
  napi_value bytes;
  napi_status status;
  void *node_bytes = NULL;
  if (async_status != napi_ok) request->status = RESULT_FAILURE;
  status = napi_create_object(env, &result);
  if (status == napi_ok) status = set_named_string(env, result, "status", status_text(request->status));
  if (status == napi_ok && request->status == RESULT_OK && request->mode == MODE_READ) {
    status = napi_create_buffer_copy(env, request->byte_count, request->bytes, &node_bytes, &bytes);
    if (status == napi_ok) status = napi_set_named_property(env, result, "bytes", bytes);
  }
  secure_free(request->bytes, request->byte_count);
  secure_free(request->target, (TARGET_MAX_CHARS + 1U) * sizeof(wchar_t));
  if (status == napi_ok) status = napi_resolve_deferred(env, request->deferred, result);
  if (status != napi_ok) {
    if (node_bytes != NULL && request->byte_count > 0U) {
      SecureZeroMemory(node_bytes, request->byte_count);
    }
    napi_value error_text;
    if (napi_create_string_utf8(env, "native-boundary-failure", NAPI_AUTO_LENGTH, &error_text) == napi_ok) {
      (void)napi_reject_deferred(env, request->deferred, error_text);
    }
  }
  (void)napi_delete_async_work(env, request->work);
  secure_free(request, sizeof(*request));
}

static napi_value start_operation(napi_env env, napi_callback_info info, operation_mode mode) {
  size_t argument_count = 1U;
  napi_value arguments[1];
  napi_value promise;
  napi_value resource_name;
  napi_valuetype type;
  credential_work *request;
  size_t target_length = 0U;
  napi_status status;

  status = napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL);
  if (status != napi_ok || argument_count != 1U || napi_typeof(env, arguments[0], &type) != napi_ok || type != napi_string) {
    napi_throw_type_error(env, NULL, "target must be one canonical string");
    return NULL;
  }
  status = napi_get_value_string_utf16(env, arguments[0], NULL, 0U, &target_length);
  if (status != napi_ok || target_length < 1U || target_length > TARGET_MAX_CHARS) {
    napi_throw_range_error(env, NULL, "target is outside the canonical bound");
    return NULL;
  }
  request = (credential_work *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*request));
  if (request == NULL) {
    napi_throw_error(env, NULL, "native-boundary-unavailable");
    return NULL;
  }
  request->target = (wchar_t *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (TARGET_MAX_CHARS + 1U) * sizeof(wchar_t));
  if (request->target == NULL) {
    secure_free(request, sizeof(*request));
    napi_throw_error(env, NULL, "native-boundary-unavailable");
    return NULL;
  }
  status = napi_get_value_string_utf16(env, arguments[0], (char16_t *)request->target, TARGET_MAX_CHARS + 1U, &target_length);
  if (status != napi_ok || !target_is_canonical(request->target, target_length)) {
    secure_free(request->target, (TARGET_MAX_CHARS + 1U) * sizeof(wchar_t));
    secure_free(request, sizeof(*request));
    napi_throw_range_error(env, NULL, "target is not canonical");
    return NULL;
  }
  request->env = env;
  request->mode = mode;
  request->status = RESULT_FAILURE;
  status = napi_create_promise(env, &request->deferred, &promise);
  if (status == napi_ok) status = napi_create_string_utf8(env, "ai-dev-os-windows-credential", NAPI_AUTO_LENGTH, &resource_name);
  if (status == napi_ok) status = napi_create_async_work(env, NULL, resource_name, execute_credential_work, complete_credential_work, request, &request->work);
  if (status == napi_ok) status = napi_queue_async_work(env, request->work);
  if (status != napi_ok) {
    if (request->work != NULL) (void)napi_delete_async_work(env, request->work);
    secure_free(request->target, (TARGET_MAX_CHARS + 1U) * sizeof(wchar_t));
    secure_free(request, sizeof(*request));
    napi_throw_error(env, NULL, "native-boundary-unavailable");
    return NULL;
  }
  return promise;
}

static napi_value availability(napi_env env, napi_callback_info info) {
  return start_operation(env, info, MODE_AVAILABILITY);
}

static napi_value read_credential(napi_env env, napi_callback_info info) {
  return start_operation(env, info, MODE_READ);
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    { "availability", NULL, availability, NULL, NULL, NULL, napi_default, NULL },
    { "read", NULL, read_credential, NULL, NULL, NULL, napi_default, NULL }
  };
  if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok) return NULL;
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
