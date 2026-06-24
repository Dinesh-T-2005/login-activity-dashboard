import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SessionTimelineComponent } from './session-timeline.component';

describe('SessionTimelineComponent', () => {
  let component: SessionTimelineComponent;
  let fixture: ComponentFixture<SessionTimelineComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SessionTimelineComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(SessionTimelineComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
