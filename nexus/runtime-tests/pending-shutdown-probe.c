/* SPDX-License-Identifier: MIT
 * Synthetic pending-work lifetime tests. No game, account, or cloud access.
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
typedef LONG (WINAPI *SetPending)(HANDLE);
typedef struct { LONG ready,completed,registered,invalid; } Evidence;
typedef struct { Evidence *e; HANDLE event; unsigned mode; SetPending set; } Work;
static DWORD WINAPI worker(void *arg)
{
    Work *w=arg;Sleep(300);
    if(w->mode==8)w->set(NULL);
    InterlockedExchange(&w->e->completed,1);SetEvent(w->event);return 0;
}
static int child(unsigned mode,HANDLE map)
{
    Evidence *e=MapViewOfFile(map,FILE_MAP_ALL_ACCESS,0,0,sizeof(*e));
    SetPending set=(void*)GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"__wine_set_pending_shutdown_event");
    if(!e||!set)return 12;
    HANDLE event=CreateEventW(NULL,TRUE,FALSE,NULL),workerEvent=NULL;
    if(!event||!DuplicateHandle(GetCurrentProcess(),event,GetCurrentProcess(),&workerEvent,0,FALSE,DUPLICATE_SAME_ACCESS))return 13;
    e->invalid=set((HANDLE)(uintptr_t)0x12345)<0;
    e->registered=set(event)==0;
    if(mode==0||mode==4||mode==11)set(NULL);
    if(mode==5)SetEvent(event);
    static Work work;
    work=(Work){e,workerEvent,mode,set};
    HANDLE thread=CreateThread(NULL,0,worker,&work,0,NULL);
    if(!thread)return 14;
    if(mode==7)CloseHandle(event); /* Wine must own an independent reference. */
    if(mode==6){
        LONG(WINAPI *lock)(ULONG,ULONG*,ULONG_PTR*)=(void*)GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"LdrLockLoaderLock");
        ULONG disposition;ULONG_PTR cookie;
        if(!lock||lock(0,&disposition,&cookie))return 15;
    }
    InterlockedExchange(&e->ready,1);
    if(mode==3){Sleep(INFINITE);return 16;}
    if(mode==12)ExitProcess(0);
    if(mode==13)return 0;
    if(mode>=9){
        LONG(WINAPI *terminate)(HANDLE,LONG)=(void*)GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtTerminateProcess");
        HANDLE process=GetCurrentProcess();
        if(mode>=14&&!DuplicateHandle(GetCurrentProcess(),process,GetCurrentProcess(),&process,0,FALSE,DUPLICATE_SAME_ACCESS))return 18;
        if(mode==15)TerminateProcess(process,0);
        terminate(process,mode==10?37:0);
    }
    TerminateProcess(GetCurrentProcess(),(mode==2||mode==10)?37:0);
    return 17;
}
static unsigned checks,failures;
#define CHECK(x) do{checks++;if(!(x)){failures++;printf("FAIL mode=%u line=%d %s\n",mode,__LINE__,#x);}}while(0)
int main(int argc,char **argv)
{
    if(argc==3)return child((unsigned)strtoul(argv[1],NULL,10),(HANDLE)(uintptr_t)strtoull(argv[2],NULL,10));
    char self[32768],cmd[33000];if(!GetModuleFileNameA(NULL,self,sizeof(self)))return 1;
    for(unsigned mode=0;mode<16;mode++){
        SECURITY_ATTRIBUTES sa={sizeof(sa),NULL,TRUE};
        HANDLE map=CreateFileMappingW(INVALID_HANDLE_VALUE,&sa,PAGE_READWRITE,0,sizeof(Evidence),NULL);
        CHECK(map!=NULL);if(!map)continue;
        Evidence *e=MapViewOfFile(map,FILE_MAP_ALL_ACCESS,0,0,sizeof(*e));
        CHECK(e!=NULL);if(!e){CloseHandle(map);continue;}ZeroMemory(e,sizeof(*e));
        snprintf(cmd,sizeof(cmd),"\"%s\" %u %llu",self,mode,(unsigned long long)(uintptr_t)map);
        STARTUPINFOA si={0};si.cb=sizeof(si);PROCESS_INFORMATION pi;
        BOOL started=CreateProcessA(self,cmd,NULL,NULL,TRUE,CREATE_NO_WINDOW,NULL,NULL,&si,&pi);
        CHECK(started);
        if(started){
            if(mode==3){DWORD until=GetTickCount()+2000;while(!e->ready&&GetTickCount()<until&&WaitForSingleObject(pi.hProcess,1)==WAIT_TIMEOUT){}CHECK(e->ready);TerminateProcess(pi.hProcess,0);}
            DWORD waited=WaitForSingleObject(pi.hProcess,5000),code=99;
            CHECK(waited==WAIT_OBJECT_0);if(waited!=WAIT_OBJECT_0)TerminateProcess(pi.hProcess,91);
            GetExitCodeProcess(pi.hProcess,&code);CHECK(code==((mode==2||mode==10)?37:0));
            CHECK(e->registered&&e->invalid);CHECK(e->completed==(mode==1||mode==7||mode==8||mode==9||mode>=12));
            CloseHandle(pi.hThread);CloseHandle(pi.hProcess);
        }
        UnmapViewOfFile(e);CloseHandle(map);
    }
    printf("CHECKS %u FAILURES %u\n",checks,failures);return failures?1:0;
}
