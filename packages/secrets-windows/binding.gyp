{
  "targets": [
    {
      "target_name": "ai_dev_os_windows_credential",
      "sources": ["native/credential-reader.c"],
      "defines": [
        "NAPI_VERSION=9",
        "UNICODE",
        "_UNICODE",
        "_WIN32_WINNT=0x0A00"
      ],
      "libraries": ["Advapi32.lib"],
      "conditions": [
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "WarningLevel": 4,
              "WarnAsError": "true",
              "SDLCheck": "true",
              "AdditionalOptions": ["/guard:cf", "/utf-8"]
            },
            "VCLinkerTool": {
              "AdditionalOptions": ["/guard:cf"]
            }
          }
        }]
      ]
    }
  ]
}
