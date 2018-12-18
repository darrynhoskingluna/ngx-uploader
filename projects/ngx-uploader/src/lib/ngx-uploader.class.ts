import { EventEmitter } from '@angular/core';
import { Observable, Subject, Subscription } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { UploadFile, UploadOutput, UploadInput, UploadStatus, BlobFile } from './interfaces';

export function humanizeBytes(bytes: number): string {
  if (bytes === 0) {
    return '0 Byte';
  }

  const k = 1024;
  const sizes: string[] = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i: number = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export class NgUploaderService {
  public queue: UploadFile[];
  public serviceEvents: EventEmitter<UploadOutput>;
  public uploadScheduler: Subject<{ file: UploadFile, event: UploadInput }>;
  public subs: { id: string, sub: Subscription }[];
  public contentTypes: string[];
  public maxUploads: number;
  
  
  constructor(concurrency: number = Number.POSITIVE_INFINITY, contentTypes: string[] = ['*'], maxUploads: number = Number.POSITIVE_INFINITY) {
    this.queue = [];
    this.serviceEvents = new EventEmitter<UploadOutput>();
    this.uploadScheduler = new Subject();
    this.subs = [];
    this.contentTypes = contentTypes;
    this.maxUploads = maxUploads;

    this.uploadScheduler
      .pipe(
        mergeMap(upload => this.startUpload(upload), concurrency)
      )
      .subscribe(uploadOutput => this.serviceEvents.emit(uploadOutput));
  }

  handleFiles(incomingFiles: FileList): void {
    const allowedIncomingFiles: File[] = [].reduce.call(incomingFiles, (acc: File[], checkFile: File, i: number) => {
      const futureQueueLength = acc.length + this.queue.length + 1;
      if (this.isContentTypeAllowed(checkFile.type) && futureQueueLength <= this.maxUploads) {
        acc = acc.concat(checkFile);
      } else {
        const rejectedFile: UploadFile = this.makeUploadFile(checkFile, i);
        this.serviceEvents.emit({ type: 'rejected', file: rejectedFile });
      }

      return acc;
    }, []);

    this.queue.push(...[].map.call(allowedIncomingFiles, (file: File, i: number) => {
      const uploadFile: UploadFile = this.makeUploadFile(file, i);
      this.serviceEvents.emit({ type: 'addedToQueue', file: uploadFile });
      return uploadFile;
    }));

    this.serviceEvents.emit({ type: 'allAddedToQueue' });
  }

  initInputEvents(input: EventEmitter<UploadInput>): Subscription {
    return input.subscribe((event: UploadInput) => {
      switch (event.type) {
        case 'uploadFile':
          const uploadFileIndex = this.queue.findIndex(file => file === event.file);
          if (uploadFileIndex !== -1 && event.file) {
            this.uploadScheduler.next({ file: this.queue[uploadFileIndex], event: event });
          }
          break;
        case 'uploadAll':
          const files = this.queue.filter(file => file.progress.status === UploadStatus.Queue);
          files.forEach(file => this.uploadScheduler.next({ file: file, event: event }));
          break;
        case 'cancel':
          const id = event.id || null;
          if (!id) {
            return;
          }
          const subs = this.subs.filter(sub => sub.id === id);
          subs.forEach(sub => {
            if (sub.sub) {
              sub.sub.unsubscribe();
              const fileIndex = this.queue.findIndex(file => file.id === id);
              if (fileIndex !== -1) {
                this.queue[fileIndex].progress.status = UploadStatus.Cancelled;
                this.serviceEvents.emit({type: 'cancelled', file: this.queue[fileIndex]});
              }
            }
          });
          break;
        case 'cancelAll':
          this.subs.forEach(sub => {
            if (sub.sub) {
              sub.sub.unsubscribe();
            }

            const file = this.queue.find(uploadFile => uploadFile.id === sub.id);
            if (file) {
              file.progress.status = UploadStatus.Cancelled;
              this.serviceEvents.emit({ type: 'cancelled', file: file });
            }
          });
          break;
        case 'remove':
          if (!event.id) {
            return;
          }

          const i = this.queue.findIndex(file => file.id === event.id);
          if (i !== -1) {
            const file = this.queue[i];
            this.queue.splice(i, 1);
            this.serviceEvents.emit({ type: 'removed', file: file });
          }
          break;
        case 'removeAll':
          if (this.queue.length) {
            this.queue = [];
            this.serviceEvents.emit({ type: 'removedAll' });
          }
          break;
      }
    });
  }

  startUpload(upload: { file: UploadFile, event: UploadInput }): Observable<UploadOutput> {
    return new Observable(observer => {
      const sub = this.uploadFile(upload.file, upload.event)
        .subscribe(output => {
          observer.next(output);
        }, err => {
          observer.error(err);
          observer.complete();
        }, () => {
          observer.complete();
        });
      this.subs.push({ id: upload.file.id, sub: sub });
    });
  }

  uploadFile(file: UploadFile, event: UploadInput): Observable<UploadOutput> {
    return new Observable(observer => {
      const time: number = new Date().getTime();
      let progressStartTime: number = (file.progress.data && file.progress.data.startTime) || time;
      let eta: number | null = null;

      event.uploadFunction(file.nativeFile).then((response) => {
        const speedAverage = Math.round(file.size / (new Date().getTime() - progressStartTime) * 1000);
        file.progress = {
          status: UploadStatus.Done,
          data: {
            percentage: 100,
            speed: speedAverage,
            speedHuman: `${humanizeBytes(speedAverage)}/s`,
            startTime: progressStartTime,
            endTime: new Date().getTime(),
            eta: eta,
            etaHuman: this.secondsToHuman(eta || 0)
          }
        };
        
        try {
          file.response = JSON.parse(response);
        } catch (e) {
          file.response = response;
        }
        observer.next({ type: 'done', file: file });
        observer.complete();
      }).catch((e) => {
        observer.error(e);
        observer.complete();
      });      

    });
  }

  secondsToHuman(sec: number): string {
    return new Date(sec * 1000).toISOString().substr(11, 8);
  }

  generateId(): string {
    return Math.random().toString(36).substring(7);
  }

  setContentTypes(contentTypes: string[]): void {
    if (typeof contentTypes != 'undefined' && contentTypes instanceof Array) {
      if (contentTypes.find((type: string) => type === '*') !== undefined) {
        this.contentTypes = ['*'];
      } else {
        this.contentTypes = contentTypes;
      }
      return;
    }
    this.contentTypes = ['*'];
  }

  allContentTypesAllowed(): boolean {
    return this.contentTypes.find((type: string) => type === '*') !== undefined;
  }

  isContentTypeAllowed(mimetype: string): boolean {
    if (this.allContentTypesAllowed()) {
      return true;
    }
    return this.contentTypes.find((type: string) => type === mimetype) !== undefined;
  }

  makeUploadFile(file: File, index: number): UploadFile {
    return {
      fileIndex: index,
      id: this.generateId(),
      name: file.name,
      size: file.size,
      type: file.type,      
      progress: {
        status: UploadStatus.Queue,
        data: {
          percentage: 0,
          speed: 0,
          speedHuman: `${humanizeBytes(0)}/s`,
          startTime: null,
          endTime: null,
          eta: null,
          etaHuman: null
        }
      },
      lastModifiedDate: file.lastModifiedDate,
      sub: undefined,
      nativeFile: file
    };
  }
}
