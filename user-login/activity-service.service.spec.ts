import { TestBed } from '@angular/core/testing';

import { ActivityServiceService } from './activity-service.service';

describe('ActivityServiceService', () => {
  let service: ActivityServiceService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ActivityServiceService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
