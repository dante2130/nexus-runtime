/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Register authenticated installed package metadata before launching its app.
 * Built against the verifier from the pinned Wine source, without duplicating it.
 */
#include <windows.h>
#include <appmodel.h>
#include <stdio.h>
#define PACKAGE_CONTAINER_REGISTRAR
#include "package_deployment.h"
int wmain(int argc, WCHAR **argv)
{
    WCHAR root[32768], container[32768], name[260];
    UINT32 length = ARRAYSIZE(name);
    DWORD n;
    LONG error;
    HRESULT hr;
    if (argc != 4 || wcscmp(argv[1], L"register-normal")) return 2;
    /* Identity is discovered from our copy in the private launch view. The
     * verifier independently binds it to signed metadata and the installed XML. */
    error = GetCurrentPackageFullName(&length, name);
    if (error) { fprintf(stderr, "Nexus package identity error=%ld\n", error); return 1; }
    n = GetFullPathNameW(argv[2], ARRAYSIZE(root), root, NULL);
    if (!n || n >= ARRAYSIZE(root)) return 2;
    while (n > 3 && root[n - 1] == '\\') root[--n] = 0;
    n = GetFullPathNameW(argv[3], ARRAYSIZE(container), container, NULL);
    if (!n || n >= ARRAYSIZE(container)) return 2;
    hr = package_deployment_register_normal(root, container, name);
    printf("Nexus package registration hr=%08lx\n", (unsigned long)hr);
    return FAILED(hr) ? 1 : 0;
}
